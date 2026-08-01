"""Schema, constraint and index checks for stock_data.

These are the cheap catalogue-only checks — they run in every profile,
including `quick`, because a missing key or a duplicated index is exactly the
kind of thing that silently degrades every later run.
"""

from __future__ import annotations

from .core import Context, Finding, Status, check, pct

# The tables/views/functions the pipeline actually reads. Sourced from
# migrations/000-005 plus the ad-hoc `stocks` / `stock_indices` /
# `stock_index_members` tables that predate the migrations directory.
REQUIRED_TABLES = {
    "stocks":              "ticker master — every other table FKs to stocks(id)",
    "price_data":          "daily OHLCV; the backbone of every simulation",
    "stock_indices":       "index definitions (SP500, NDX, RUA, ...)",
    "stock_index_members": "current index membership, multi-index",
    "stock_fundamentals":  "point-in-time fundamentals snapshots",
}
OPTIONAL_TABLES = {
    "stock_financials":          "SEC XBRL line items (migration 005)",
    "stock_catalysts":           "extracted corporate events (migration 004)",
    "index_constituent_history": "add/remove log — needed for survivorship-free backtests",
}
REQUIRED_VIEWS = {
    "current_fundamentals": "latest snapshot per stock (DISTINCT ON)",
}
OPTIONAL_FUNCTIONS = {
    "sp500_members_at": "point-in-time SP500 membership (migration 002)",
}

# column -> (expected data_type prefix, must_be_not_null)
PRICE_DATA_COLUMNS = {
    "stock_id":  ("integer", True),
    "date":      ("date", True),
    "open":      ("double precision", False),
    "high":      ("double precision", False),
    "low":       ("double precision", False),
    "close":     ("double precision", False),
    "adj_close": ("double precision", False),
    "volume":    ("bigint", False),
}

STOCKS_EXPECTED_COLUMNS = ("id", "ticker", "name", "sector", "industry",
                           "market_cap", "exchange")


@check("schema.tables", "schema", "Required tables and views exist",
       min_profile="quick")
def check_required_objects(ctx: Context):
    tables, views = ctx.tables, ctx.views
    missing = {n: why for n, why in REQUIRED_TABLES.items() if n not in tables}
    missing_views = {n: why for n, why in REQUIRED_VIEWS.items() if n not in views}

    if missing or missing_views:
        gone = {**missing, **missing_views}
        return Finding(
            "schema.tables", "schema", "Required tables and views exist",
            Status.FAIL,
            f"{len(gone)} required object(s) missing: {', '.join(sorted(gone))}",
            metrics={"missing": sorted(gone)},
            samples=[{"object": n, "purpose": w} for n, w in sorted(gone.items())],
            remediation="Apply the migrations in order: "
                        "for f in migrations/*.sql; do psql -d stock_data -f $f; done",
        )

    absent_optional = sorted(
        [n for n in OPTIONAL_TABLES if n not in tables] +
        [n for n in OPTIONAL_FUNCTIONS
         if not ctx.scalar("SELECT 1 FROM pg_proc WHERE proname = %s LIMIT 1", (n,))]
    )
    if absent_optional:
        return Finding(
            "schema.tables", "schema", "Required tables and views exist",
            Status.WARN,
            f"all required objects present; {len(absent_optional)} optional "
            f"object(s) absent: {', '.join(absent_optional)}",
            metrics={"missing_optional": absent_optional},
            samples=[{"object": n,
                      "purpose": OPTIONAL_TABLES.get(n) or OPTIONAL_FUNCTIONS.get(n, "")}
                     for n in absent_optional],
            remediation="index_constituent_history in particular: without it "
                        "sp500_members_at() cannot reconstruct historical "
                        "membership and every backtest carries survivorship bias.",
        )
    return None


@check("schema.price_columns", "schema", "price_data column contract",
       min_profile="quick")
def check_price_columns(ctx: Context):
    if not ctx.has_table("price_data"):
        return Finding("schema.price_columns", "schema", "price_data column contract",
                       Status.SKIP, "price_data missing")
    cols = ctx.columns("price_data")
    problems = []
    for name, (want_type, want_notnull) in PRICE_DATA_COLUMNS.items():
        c = cols.get(name)
        if not c:
            problems.append({"column": name, "issue": "missing"})
            continue
        if not c["data_type"].startswith(want_type):
            problems.append({"column": name, "issue": "type",
                             "expected": want_type, "actual": c["data_type"]})
        if want_notnull and c["is_nullable"] == "YES":
            problems.append({"column": name, "issue": "nullable",
                             "expected": "NOT NULL"})
    if problems:
        return Finding(
            "schema.price_columns", "schema", "price_data column contract",
            Status.FAIL,
            f"{len(problems)} column contract violation(s) on price_data",
            metrics={"violations": len(problems)}, samples=problems,
            remediation="A nullable stock_id or date means the (stock_id,date) "
                        "key is not a full key and duplicate history can creep in. "
                        "See migrations/000_price_data.sql for the intended shape.",
        )
    return None


@check("schema.stocks_columns", "schema", "stocks column contract",
       min_profile="quick")
def check_stocks_columns(ctx: Context):
    if not ctx.has_table("stocks"):
        return Finding("schema.stocks_columns", "schema", "stocks column contract",
                       Status.SKIP, "stocks missing")
    cols = ctx.columns("stocks")
    missing = [c for c in STOCKS_EXPECTED_COLUMNS if c not in cols]
    if missing:
        return Finding(
            "schema.stocks_columns", "schema", "stocks column contract",
            Status.FAIL,
            f"stocks is missing {len(missing)} column(s) the screener selects: "
            f"{', '.join(missing)}",
            metrics={"missing": missing},
            remediation="contrarian_screener.fetch_universe_data_from_db() does "
                        "SELECT id, ticker, name, sector, industry, market_cap — "
                        "a missing column there fails the whole screener run.",
        )
    return None


@check("schema.price_key", "schema", "price_data (stock_id, date) key enforced",
       min_profile="quick")
def check_price_key(ctx: Context):
    """The natural key may be a PRIMARY KEY *or* a UNIQUE NOT NULL constraint.

    migrations/000 documents that the live DB uses the latter (the surrogate
    id/PK was dropped in July 2026). Either satisfies
    `INSERT ... ON CONFLICT (stock_id, date)`, which the updater depends on —
    without it every run would raise instead of upserting.
    """
    if not ctx.has_table("price_data"):
        return Finding("schema.price_key", "schema",
                       "price_data (stock_id, date) key enforced",
                       Status.SKIP, "price_data missing")
    rows = ctx.query_dicts("""
        SELECT c.conname, c.contype,
               ARRAY(SELECT a.attname
                       FROM unnest(c.conkey) k
                       JOIN pg_attribute a
                         ON a.attrelid = c.conrelid AND a.attnum = k) AS cols
          FROM pg_constraint c
         WHERE c.conrelid = 'price_data'::regclass
           AND c.contype IN ('p', 'u')
    """)
    key = next((r for r in rows if sorted(r["cols"]) == ["date", "stock_id"]), None)
    if not key:
        return Finding(
            "schema.price_key", "schema", "price_data (stock_id, date) key enforced",
            Status.FAIL,
            "no PRIMARY KEY or UNIQUE constraint on (stock_id, date)",
            metrics={"constraints": [r["conname"] for r in rows]},
            remediation="Without it, ON CONFLICT (stock_id, date) in "
                        "update_stock_data.py errors out and duplicate price rows "
                        "become possible — which double-counts returns in backtests. "
                        "Fix: ALTER TABLE price_data ADD CONSTRAINT "
                        "price_data_stock_id_date_key UNIQUE (stock_id, date);",
        )
    kind = "PRIMARY KEY" if key["contype"] == "p" else "UNIQUE"
    return Finding(
        "schema.price_key", "schema", "price_data (stock_id, date) key enforced",
        Status.PASS, f"{kind} constraint {key['conname']} covers (stock_id, date)",
        metrics={"constraint": key["conname"], "kind": kind},
    )


@check("schema.redundant_indexes", "schema", "No redundant indexes",
       min_profile="quick")
def check_redundant_indexes(ctx: Context):
    """Detect indexes whose leading columns are a prefix of another index.

    This is the regression migrations/000 warns about at length: six manually
    created duplicates on price_data once cost ~5 GB and slowed every write
    (7.8 GB of indexes against 4.1 GB of data). Catching it automatically is
    worth more than the warning comment.
    """
    idx = ctx.query_dicts("""
        SELECT i.indexrelid::regclass::text AS index_name,
               i.indrelid::regclass::text   AS table_name,
               i.indisunique                AS is_unique,
               i.indisprimary               AS is_primary,
               pg_relation_size(i.indexrelid) AS bytes,
               ARRAY(SELECT pg_get_indexdef(i.indexrelid, k + 1, true)
                       FROM generate_subscripts(i.indkey, 1) k
                      ORDER BY k)          AS cols,
               i.indpred IS NOT NULL        AS is_partial
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
    """)

    redundant = []
    by_table: dict[str, list[dict]] = {}
    for r in idx:
        by_table.setdefault(r["table_name"], []).append(r)

    for table, entries in by_table.items():
        for a in entries:
            if a["is_partial"]:
                continue                       # partial indexes serve a filter
            for b in entries:
                if a["index_name"] == b["index_name"] or b["is_partial"]:
                    continue
                # a is redundant if its column list is a prefix of b's and b is
                # at least as strong (unique/primary beats plain).
                if len(a["cols"]) > len(b["cols"]):
                    continue
                if a["cols"] != b["cols"][:len(a["cols"])]:
                    continue
                if a["is_unique"] and not b["is_unique"]:
                    continue
                if a["cols"] == b["cols"]:
                    # Exact duplicate — keep the primary/unique/oldest one.
                    if a["is_primary"] or (a["is_unique"] and not b["is_unique"]):
                        continue
                    if not a["is_primary"] and not b["is_primary"] and \
                            a["index_name"] > b["index_name"]:
                        pass                   # deterministic: drop the later name
                    else:
                        continue
                redundant.append({
                    "table": table,
                    "redundant_index": a["index_name"],
                    "columns": a["cols"],
                    "covered_by": b["index_name"],
                    "covering_columns": b["cols"],
                    "wasted_mb": round(a["bytes"] / 1024 / 1024, 1),
                })
                break

    if not redundant:
        return None
    wasted = sum(r["wasted_mb"] for r in redundant)
    return Finding(
        "schema.redundant_indexes", "schema", "No redundant indexes",
        Status.WARN,
        f"{len(redundant)} redundant index(es) wasting {wasted:.0f} MB",
        metrics={"count": len(redundant), "wasted_mb": round(wasted, 1)},
        samples=redundant[:ctx.sample_limit],
        remediation="Each duplicate must be updated on every INSERT, so this "
                    "slows the daily price load as well as wasting disk. "
                    "Verify with \\d price_data, then DROP INDEX <name>. "
                    "See the warning block in migrations/000_price_data.sql.",
    )


@check("schema.unused_indexes", "schema", "No never-scanned indexes",
       min_profile="deep")
def check_unused_indexes(ctx: Context):
    """Indexes with zero scans since the last stats reset.

    Informational rather than WARN: a freshly reset stats counter, or an index
    that only serves a quarterly job, will legitimately show zero.
    """
    rows = ctx.query_dicts("""
        SELECT s.relname AS table_name, s.indexrelname AS index_name,
               s.idx_scan, pg_relation_size(s.indexrelid) AS bytes
          FROM pg_stat_user_indexes s
          JOIN pg_index i ON i.indexrelid = s.indexrelid
         WHERE s.schemaname = 'public'
           AND s.idx_scan = 0
           AND NOT i.indisprimary
           AND NOT i.indisunique
           AND pg_relation_size(s.indexrelid) > 10 * 1024 * 1024
         ORDER BY bytes DESC
    """)
    if not rows:
        return None
    total_mb = sum(r["bytes"] for r in rows) / 1024 / 1024
    reset = ctx.scalar("SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()")
    return Finding(
        "schema.unused_indexes", "schema", "No never-scanned indexes",
        Status.INFO,
        f"{len(rows)} index(es) >10 MB never scanned ({total_mb:.0f} MB total)",
        metrics={"count": len(rows), "total_mb": round(total_mb, 1),
                 "stats_reset": reset},
        samples=[{"table": r["table_name"], "index": r["index_name"],
                  "mb": round(r["bytes"] / 1024 / 1024, 1)}
                 for r in rows[:ctx.sample_limit]],
        remediation="Confirm against the workload before dropping — stats were "
                    f"last reset at {reset}. An index unused since then is a "
                    "write-path tax on the daily price load.",
    )


@check("schema.foreign_keys", "schema", "Foreign keys present and validated",
       min_profile="quick")
def check_foreign_keys(ctx: Context):
    """Every child table must FK to stocks(id), and the FK must be VALIDATED.

    A NOT VALID foreign key still guards new rows but says nothing about the
    rows already there — so orphaned price history could be sitting in the
    table unnoticed.
    """
    children = [t for t in ("price_data", "stock_fundamentals",
                            "stock_financials", "stock_catalysts",
                            "stock_index_members")
                if ctx.has_table(t)]
    rows = ctx.query_dicts("""
        SELECT c.conrelid::regclass::text AS child,
               c.confrelid::regclass::text AS parent,
               c.conname, c.convalidated
          FROM pg_constraint c
         WHERE c.contype = 'f'
           AND c.connamespace = 'public'::regnamespace
    """)
    have = {r["child"]: r for r in rows}
    problems = []
    for t in children:
        r = have.get(t)
        if not r:
            problems.append({"table": t, "issue": "no foreign key to stocks(id)"})
        elif not r["convalidated"]:
            problems.append({"table": t, "constraint": r["conname"],
                             "issue": "NOT VALID — existing rows unchecked"})
    if problems:
        return Finding(
            "schema.foreign_keys", "schema", "Foreign keys present and validated",
            Status.WARN,
            f"{len(problems)} table(s) without a validated FK to stocks(id)",
            metrics={"count": len(problems)}, samples=problems,
            remediation="Without a validated FK, deleting a ticker from stocks "
                        "can strand its price history, which then never appears "
                        "in any join but still occupies the table. Fix with "
                        "ALTER TABLE <t> VALIDATE CONSTRAINT <name>;",
        )
    return None


@check("schema.orphan_rows", "schema", "No orphaned child rows",
       min_profile="standard")
def check_orphans(ctx: Context):
    """Belt-and-braces: count child rows whose stock_id has no stocks row."""
    out = []
    for t in ("price_data", "stock_fundamentals", "stock_financials",
              "stock_catalysts", "stock_index_members"):
        if not ctx.has_table(t):
            continue
        n = ctx.scalar(f"""
            SELECT COUNT(*) FROM {t} c
             WHERE NOT EXISTS (SELECT 1 FROM stocks s WHERE s.id = c.stock_id)
        """)
        if n:
            out.append({"table": t, "orphan_rows": int(n)})
    if not out:
        return None
    total = sum(r["orphan_rows"] for r in out)
    return Finding(
        "schema.orphan_rows", "schema", "No orphaned child rows",
        Status.FAIL,
        f"{total:,} orphaned row(s) across {len(out)} table(s)",
        metrics={"total": total}, samples=out,
        remediation="Orphans are invisible to every JOIN in the screener but "
                    "still counted by row-count checks, so coverage metrics "
                    "read higher than reality. Delete them or restore the "
                    "missing stocks rows.",
    )


@check("schema.duplicate_prices", "schema", "No duplicate (stock_id, date) rows",
       min_profile="standard", heavy=True)
def check_duplicate_prices(ctx: Context):
    """Should be impossible given the key — but verify, because a duplicate
    price row double-counts a day's return in every backtest that reads it."""
    rows = ctx.query_dicts("""
        SELECT stock_id, date, COUNT(*) AS n
          FROM price_data
         WHERE date >= %s
         GROUP BY stock_id, date
        HAVING COUNT(*) > 1
         LIMIT 100
    """, (ctx.window_start,))
    if not rows:
        return None
    return Finding(
        "schema.duplicate_prices", "schema", "No duplicate (stock_id, date) rows",
        Status.FAIL,
        f"{len(rows)} duplicated (stock_id, date) pair(s) in the last "
        f"{ctx.window_days} days",
        metrics={"count": len(rows)}, samples=rows[:ctx.sample_limit],
        remediation="Deduplicate, then restore the unique constraint — every "
                    "duplicate compounds an extra day of return into the panel.",
    )


@check("schema.sequences", "schema", "Sequences have headroom", min_profile="deep")
def check_sequences(ctx: Context):
    rows = ctx.query_dicts("""
        SELECT schemaname, sequencename, last_value, max_value
          FROM pg_sequences
         WHERE schemaname = 'public' AND last_value IS NOT NULL
    """)
    hot = []
    for r in rows:
        if not r["max_value"]:
            continue
        used = float(r["last_value"]) / float(r["max_value"])
        if used > ctx.t.sequence_usage_warn:
            hot.append({"sequence": r["sequencename"], "used": pct(used)})
    if not hot:
        return None
    return Finding(
        "schema.sequences", "schema", "Sequences have headroom", Status.WARN,
        f"{len(hot)} sequence(s) past {pct(ctx.t.sequence_usage_warn)} of range",
        metrics={"count": len(hot)}, samples=hot,
        remediation="ALTER SEQUENCE ... AS bigint (or restart it) before the "
                    "next insert fails.",
    )
