"""Operational health of the Postgres instance itself.

price_data is a 36M-row, multi-GB table that takes a bulk insert every
weekday. That workload has predictable failure modes — autovacuum falling
behind, planner stats going stale after a big load, index set drifting — and
each of them shows up first as "the screener got slow", not as an error.
"""

from __future__ import annotations

from .core import Context, Finding, Status, check, pct


@check("ops.server", "operations", "Server and database identity",
       min_profile="quick")
def check_server(ctx: Context):
    row = ctx.query_dicts("""
        SELECT current_database() AS db, current_user AS usr,
               version() AS version,
               pg_size_pretty(pg_database_size(current_database())) AS size,
               pg_database_size(current_database()) AS size_bytes,
               (SELECT COUNT(*) FROM pg_stat_activity
                 WHERE datname = current_database()) AS connections
    """)[0]
    server_version = ctx.scalar("SHOW server_version")
    return Finding(
        "ops.server", "operations", "Server and database identity", Status.INFO,
        f"{row['db']} on PostgreSQL {server_version} as {row['usr']} — "
        f"{row['size']}",
        metrics={"database": row["db"], "user": row["usr"],
                 "server_version": server_version,
                 "size_bytes": int(row["size_bytes"]),
                 "size_pretty": row["size"],
                 "connections": row["connections"]},
    )


@check("ops.table_sizes", "operations", "Table and index sizes", min_profile="standard")
def check_table_sizes(ctx: Context):
    rows = ctx.query_dicts("""
        SELECT c.relname AS table_name,
               pg_table_size(c.oid)   AS table_bytes,
               pg_indexes_size(c.oid) AS index_bytes,
               pg_total_relation_size(c.oid) AS total_bytes,
               c.reltuples::bigint    AS est_rows
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
         ORDER BY pg_total_relation_size(c.oid) DESC
    """)
    flagged = [
        r for r in rows
        if r["table_bytes"] > ctx.t.min_table_bytes_for_bloat
        and r["index_bytes"] > r["table_bytes"] * ctx.t.index_to_table_ratio_warn
    ]
    samples = [{"table": r["table_name"],
                "table_mb": round(r["table_bytes"] / 1024 / 1024, 1),
                "index_mb": round(r["index_bytes"] / 1024 / 1024, 1),
                "index_ratio": round(r["index_bytes"] / r["table_bytes"], 2)
                if r["table_bytes"] else None,
                "est_rows": r["est_rows"]} for r in rows[:ctx.sample_limit]]
    if not flagged:
        return Finding(
            "ops.table_sizes", "operations", "Table and index sizes", Status.INFO,
            f"{len(rows)} table(s); largest is {rows[0]['table_name']} at "
            f"{rows[0]['total_bytes'] / 1024 ** 3:.2f} GB" if rows else "no tables",
            metrics={"tables": len(rows)}, samples=samples,
        )
    return Finding(
        "ops.table_sizes", "operations", "Table and index sizes", Status.WARN,
        f"{len(flagged)} table(s) carry more index than data",
        metrics={"flagged": [r["table_name"] for r in flagged]},
        samples=samples,
        remediation="This is exactly the 2026-07-18 regression on price_data "
                    "(7.8 GB of indexes against 4.1 GB of data). Cross-check "
                    "schema.redundant_indexes and drop what is duplicated.",
    )


@check("ops.autovacuum", "operations", "Autovacuum is keeping up",
       min_profile="standard")
def check_autovacuum(ctx: Context):
    rows = ctx.query_dicts("""
        SELECT relname AS table_name, n_live_tup, n_dead_tup,
               last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
          FROM pg_stat_user_tables
         WHERE schemaname = 'public'
         ORDER BY n_dead_tup DESC
    """)
    bad = []
    for r in rows:
        live, dead = r["n_live_tup"] or 0, r["n_dead_tup"] or 0
        if live + dead < 10_000:
            continue
        ratio = dead / (live + dead)
        if ratio > ctx.t.dead_tuple_ratio_warn:
            bad.append({"table": r["table_name"], "live": live, "dead": dead,
                        "dead_ratio": round(ratio, 3),
                        "last_autovacuum": r["last_autovacuum"]})
    if not bad:
        return None
    severe = [r for r in bad if r["dead_ratio"] > ctx.t.dead_tuple_ratio_fail]
    return Finding(
        "ops.autovacuum", "operations", "Autovacuum is keeping up",
        Status.FAIL if severe else Status.WARN,
        f"{len(bad)} table(s) above {pct(ctx.t.dead_tuple_ratio_warn)} dead "
        f"tuples ({len(severe)} severe)",
        metrics={"count": len(bad), "severe": len(severe)},
        samples=bad[:ctx.sample_limit],
        remediation="Dead tuples make every sequential scan read pages that "
                    "hold nothing, which shows up as the screener getting "
                    "slower for no visible reason. Run VACUUM (ANALYZE) "
                    "<table>, and consider a lower autovacuum_vacuum_scale_"
                    "factor on price_data given its daily bulk inserts.",
    )


@check("ops.planner_stats", "operations", "Planner statistics are fresh",
       min_profile="standard")
def check_planner_stats(ctx: Context):
    rows = ctx.query_dicts("""
        SELECT relname AS table_name, n_live_tup,
               GREATEST(COALESCE(last_analyze,  '-infinity'::timestamptz),
                        COALESCE(last_autoanalyze, '-infinity'::timestamptz)) AS analyzed,
               n_mod_since_analyze
          FROM pg_stat_user_tables
         WHERE schemaname = 'public'
         ORDER BY n_live_tup DESC
    """)
    stale = []
    for r in rows:
        if (r["n_live_tup"] or 0) < 10_000:
            continue
        analyzed = r["analyzed"]
        if analyzed is None or analyzed.year < 1900:
            stale.append({"table": r["table_name"], "last_analyze": None,
                          "rows_modified_since": r["n_mod_since_analyze"]})
            continue
        age_days = (ctx.today - analyzed.date()).days
        if age_days > ctx.t.analyze_max_age_days:
            stale.append({"table": r["table_name"],
                          "last_analyze": analyzed, "age_days": age_days,
                          "rows_modified_since": r["n_mod_since_analyze"]})
    if not stale:
        return None
    return Finding(
        "ops.planner_stats", "operations", "Planner statistics are fresh",
        Status.WARN,
        f"{len(stale)} large table(s) not ANALYZEd in "
        f"{ctx.t.analyze_max_age_days}d",
        metrics={"count": len(stale)}, samples=stale[:ctx.sample_limit],
        remediation="Stale stats on price_data make the planner mis-estimate "
                    "the (stock_id, date) range scans the screener runs, and it "
                    "can switch to a seq scan over 36M rows. Run ANALYZE "
                    "price_data; after each bulk load.",
    )


@check("ops.cache_hit_ratio", "operations", "Buffer cache hit ratio",
       min_profile="deep")
def check_cache_hit(ctx: Context):
    row = ctx.query_dicts("""
        SELECT SUM(heap_blks_hit) AS hit, SUM(heap_blks_read) AS read
          FROM pg_statio_user_tables WHERE schemaname = 'public'
    """)[0]
    hit, read = int(row["hit"] or 0), int(row["read"] or 0)
    if hit + read == 0:
        return Finding("ops.cache_hit_ratio", "operations",
                       "Buffer cache hit ratio", Status.SKIP,
                       "no I/O statistics recorded yet")
    ratio = hit / (hit + read)
    status = Status.INFO if ratio >= 0.95 else Status.WARN
    return Finding(
        "ops.cache_hit_ratio", "operations", "Buffer cache hit ratio", status,
        f"heap cache hit ratio {pct(ratio)}",
        metrics={"hit": hit, "read": read, "ratio": round(ratio, 4)},
        remediation="Below ~95% on a workload that repeatedly scans the same "
                    "recent price window suggests shared_buffers is too small "
                    "for the working set.",
    )


@check("ops.long_running", "operations", "No stuck queries or idle transactions",
       min_profile="standard")
def check_long_running(ctx: Context):
    rows = ctx.query_dicts("""
        SELECT pid, state, wait_event_type, wait_event,
               EXTRACT(EPOCH FROM (now() - xact_start))::int AS xact_seconds,
               left(query, 160) AS query
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND state <> 'idle'
           AND xact_start IS NOT NULL
           AND now() - xact_start > INTERVAL '5 minutes'
         ORDER BY xact_start
    """)
    if not rows:
        return None
    idle_in_txn = [r for r in rows if r["state"] == 'idle in transaction']
    return Finding(
        "ops.long_running", "operations", "No stuck queries or idle transactions",
        Status.WARN,
        f"{len(rows)} session(s) in a transaction older than 5 minutes "
        f"({len(idle_in_txn)} idle in transaction)",
        metrics={"count": len(rows), "idle_in_transaction": len(idle_in_txn)},
        samples=rows[:ctx.sample_limit],
        remediation="An idle-in-transaction session holds back the vacuum "
                    "horizon, so dead tuples on price_data accumulate no matter "
                    "how often autovacuum runs. Usually an updater run that "
                    "died without committing.",
    )


@check("ops.bloat_estimate", "operations", "Table bloat estimate", min_profile="deep")
def check_bloat(ctx: Context):
    """Rough bloat estimate from pgstattuple if available, else skip.

    pgstattuple is exact but scans the table, so it is deep-profile only and
    limited to tables that are large enough for bloat to matter.
    """
    has_ext = ctx.scalar(
        "SELECT 1 FROM pg_extension WHERE extname = 'pgstattuple' LIMIT 1")
    if not has_ext:
        return Finding(
            "ops.bloat_estimate", "operations", "Table bloat estimate",
            Status.SKIP,
            "pgstattuple extension not installed",
            remediation="Optional: CREATE EXTENSION pgstattuple; enables exact "
                        "bloat measurement. ops.autovacuum already gives the "
                        "cheap approximation.",
        )
    out = []
    for r in ctx.query_dicts("""
        SELECT c.relname, pg_table_size(c.oid) AS bytes
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND pg_table_size(c.oid) > %s
         ORDER BY pg_table_size(c.oid) DESC LIMIT 5
    """, (ctx.t.min_table_bytes_for_bloat,)):
        st = ctx.query_dicts(
            "SELECT free_percent, dead_tuple_percent FROM pgstattuple(%s)",
            (r["relname"],))[0]
        out.append({"table": r["relname"],
                    "free_percent": float(st["free_percent"]),
                    "dead_tuple_percent": float(st["dead_tuple_percent"])})
    bad = [r for r in out if r["free_percent"] > 25]
    return Finding(
        "ops.bloat_estimate", "operations", "Table bloat estimate",
        Status.WARN if bad else Status.INFO,
        f"measured {len(out)} large table(s); {len(bad)} above 25% free space",
        metrics={"tables": len(out)}, samples=out,
        remediation="VACUUM FULL or pg_repack reclaims it, but both take an "
                    "exclusive lock — schedule outside the daily load window.",
    )
