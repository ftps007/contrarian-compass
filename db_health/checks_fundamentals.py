"""Fundamentals and index-membership quality checks.

The screener's valuation, quality and sentiment factors all read
`current_fundamentals`. Unlike prices, a wrong fundamental does not look wrong
— a P/E of 4 from a stale or mis-parsed snapshot is exactly what a contrarian
screen is hunting for, so bad fundamentals data preferentially surfaces at the
*top* of the ranking. That asymmetry is why these checks exist.
"""

from __future__ import annotations

from datetime import timedelta

from .core import (Context, Finding, Status, check, escalate_ratio, pct,
                   quote_ident)


@check("fund.coverage", "fundamentals", "Fundamentals cover the universe",
       min_profile="standard")
def check_fundamentals_coverage(ctx: Context):
    if not ctx.has_table("stock_fundamentals"):
        return Finding("fund.coverage", "fundamentals",
                       "Fundamentals cover the universe", Status.SKIP,
                       "stock_fundamentals not present")
    uni = ctx.universe_ids
    if not uni:
        return Finding("fund.coverage", "fundamentals",
                       "Fundamentals cover the universe", Status.SKIP,
                       f"universe {ctx.universe!r} resolved to 0 stocks")
    have = int(ctx.scalar("""
        SELECT COUNT(DISTINCT stock_id) FROM stock_fundamentals
         WHERE stock_id = ANY(%s)
    """, (uni,)) or 0)
    ratio = have / len(uni)
    samples = ctx.query_dicts("""
        SELECT s.ticker, s.name, s.sector FROM stocks s
         WHERE s.id = ANY(%s)
           AND NOT EXISTS (SELECT 1 FROM stock_fundamentals f
                            WHERE f.stock_id = s.id)
         ORDER BY s.ticker LIMIT %s
    """, (uni, ctx.sample_limit))
    return Finding(
        "fund.coverage", "fundamentals", "Fundamentals cover the universe",
        escalate_ratio(ratio, ctx.t.fundamentals_coverage_warn,
                       ctx.t.fundamentals_coverage_fail),
        f"{have:,}/{len(uni):,} ({pct(ratio)}) of the {ctx.universe} universe "
        f"has at least one fundamentals snapshot",
        metrics={"covered": have, "universe_size": len(uni),
                 "coverage": round(ratio, 4)},
        samples=samples,
        remediation="Run update_stock_data.py --fundamentals-only "
                    f"--universe {ctx.universe}. Names without fundamentals "
                    "score NULL on every valuation factor and drop out of the "
                    "ranking rather than ranking badly.",
    )


@check("fund.snapshot_recency", "fundamentals",
       "Per-stock snapshots are individually fresh", min_profile="standard")
def check_snapshot_recency(ctx: Context):
    """MAX(snapshot_date) being fresh does not mean every stock is fresh.

    The fundamentals loop is per-ticker over ~3000 names; if it dies partway,
    the newest snapshot_date looks current while most stocks still carry last
    month's numbers.
    """
    if not ctx.has_table("stock_fundamentals"):
        return Finding("fund.snapshot_recency", "fundamentals",
                       "Per-stock snapshots are individually fresh",
                       Status.SKIP, "stock_fundamentals not present")
    uni = ctx.universe_ids
    if not uni:
        return Finding("fund.snapshot_recency", "fundamentals",
                       "Per-stock snapshots are individually fresh",
                       Status.SKIP, f"universe {ctx.universe!r} resolved to 0 stocks")
    # Ignore future-dated snapshots when establishing "newest" — otherwise one
    # bad row pushes the cutoff forward and every healthy stock reads as stale.
    newest = ctx.scalar("SELECT MAX(snapshot_date) FROM stock_fundamentals "
                        " WHERE snapshot_date <= CURRENT_DATE")
    if newest is None:
        return Finding("fund.snapshot_recency", "fundamentals",
                       "Per-stock snapshots are individually fresh",
                       Status.WARN, "stock_fundamentals is empty")
    cutoff = newest - timedelta(days=ctx.t.fundamentals_max_age_days)
    rows = ctx.query_dicts("""
        SELECT s.ticker, MAX(f.snapshot_date) AS last_snapshot
          FROM stocks s JOIN stock_fundamentals f ON f.stock_id = s.id
         WHERE s.id = ANY(%s)
         GROUP BY s.ticker
        HAVING MAX(f.snapshot_date) < %s
         ORDER BY MAX(f.snapshot_date)
    """, (uni, cutoff))
    if not rows:
        return None
    ratio = len(rows) / len(uni)
    status = Status.FAIL if ratio > 0.25 else Status.WARN
    return Finding(
        "fund.snapshot_recency", "fundamentals",
        "Per-stock snapshots are individually fresh", status,
        f"{len(rows):,}/{len(uni):,} ({pct(ratio)}) universe members have not "
        f"been re-snapshotted within {ctx.t.fundamentals_max_age_days}d of the "
        f"newest snapshot ({newest})",
        metrics={"stale": len(rows), "universe_size": len(uni),
                 "newest_snapshot": newest, "ratio": round(ratio, 4)},
        samples=rows[:ctx.sample_limit],
        remediation="A partial fundamentals run leaves MAX(snapshot_date) "
                    "looking current while most stocks are stale — this check "
                    "is the only thing that distinguishes the two. Re-run "
                    "update_stock_data.py --fundamentals-only.",
    )


@check("fund.plausibility", "fundamentals", "Fundamental values are plausible",
       min_profile="standard")
def check_fundamentals_plausibility(ctx: Context):
    """Range checks on the latest snapshot per stock.

    Deliberately loose — the goal is catching parse/unit errors (a ROE of 4200,
    a negative market cap), not second-guessing genuinely extreme companies.
    """
    if "current_fundamentals" not in ctx.views:
        return Finding("fund.plausibility", "fundamentals",
                       "Fundamental values are plausible", Status.SKIP,
                       "current_fundamentals view not present")
    t = ctx.t
    rows = ctx.query_dicts("""
        SELECT s.ticker, f.snapshot_date, f.trailing_pe, f.forward_pe,
               f.roe, f.debt_to_equity, f.operating_margin, f.market_cap,
               f.short_pct_float, f.recommendation_mean,
               ARRAY_REMOVE(ARRAY[
                 CASE WHEN abs(f.trailing_pe)  > %(pe)s        THEN 'trailing_pe'     END,
                 CASE WHEN abs(f.forward_pe)   > %(pe)s        THEN 'forward_pe'      END,
                 CASE WHEN abs(f.roe)          > %(roe)s       THEN 'roe'             END,
                 CASE WHEN abs(f.debt_to_equity) > %(de)s      THEN 'debt_to_equity'  END,
                 CASE WHEN abs(f.operating_margin) > %(mar)s   THEN 'operating_margin'END,
                 CASE WHEN f.market_cap < 0                    THEN 'market_cap<0'    END,
                 CASE WHEN f.short_pct_float < 0
                        OR f.short_pct_float > 100             THEN 'short_pct_float' END,
                 CASE WHEN f.recommendation_mean < 1
                        OR f.recommendation_mean > 5           THEN 'recommendation_mean' END
               ], NULL) AS bad_fields
          FROM current_fundamentals f JOIN stocks s ON s.id = f.stock_id
         WHERE abs(f.trailing_pe) > %(pe)s OR abs(f.forward_pe) > %(pe)s
            OR abs(f.roe) > %(roe)s OR abs(f.debt_to_equity) > %(de)s
            OR abs(f.operating_margin) > %(mar)s OR f.market_cap < 0
            OR f.short_pct_float < 0 OR f.short_pct_float > 100
            OR f.recommendation_mean < 1 OR f.recommendation_mean > 5
         LIMIT 1000
    """, {"pe": t.pe_ceiling, "roe": t.roe_abs_ceiling,
          "de": t.debt_to_equity_ceiling, "mar": t.margin_abs_ceiling})
    if not rows:
        return None
    field_counts: dict[str, int] = {}
    for r in rows:
        for f in r["bad_fields"] or []:
            field_counts[f] = field_counts.get(f, 0) + 1
    return Finding(
        "fund.plausibility", "fundamentals", "Fundamental values are plausible",
        Status.WARN,
        f"{len(rows)} stock(s) carry out-of-range fundamentals "
        f"({', '.join(f'{k}={v}' for k, v in sorted(field_counts.items()))})",
        metrics={"count": len(rows), "by_field": field_counts},
        samples=[{"ticker": r["ticker"], "snapshot_date": r["snapshot_date"],
                  "bad_fields": r["bad_fields"], "trailing_pe": r["trailing_pe"],
                  "roe": r["roe"], "debt_to_equity": r["debt_to_equity"]}
                 for r in rows[:ctx.sample_limit]],
        remediation="Usually a yfinance unit change (ratio vs percent) or a "
                    "parse failure. These land at the extremes of the z-score "
                    "in screener_zscore.py, so they distort the whole "
                    "cross-sectional ranking, not just their own row.",
    )


@check("fund.empty_snapshots", "fundamentals",
       "Snapshots are not empty shells", min_profile="standard")
def check_empty_snapshots(ctx: Context):
    """Rows where every fundamental field is NULL.

    The updater writes one row per stock per run; when a yfinance `.info` call
    fails it can still write an all-NULL row. That row then wins
    `DISTINCT ON (stock_id) ORDER BY snapshot_date DESC` in
    `current_fundamentals` and *hides* the good snapshot from the day before.
    """
    if not ctx.has_table("stock_fundamentals"):
        return Finding("fund.empty_snapshots", "fundamentals",
                       "Snapshots are not empty shells", Status.SKIP,
                       "stock_fundamentals not present")
    cols = [c for c in ctx.columns("stock_fundamentals")
            if c not in ("stock_id", "snapshot_date", "fetched_at")]
    if not cols:
        return None
    # Qualify with the alias: current_fundamentals and stocks both expose
    # market_cap, so an unqualified predicate is ambiguous once joined.
    all_null = " AND ".join(f"f.{quote_ident(c)} IS NULL" for c in cols)
    total = int(ctx.scalar("SELECT COUNT(*) FROM stock_fundamentals") or 1)
    n = int(ctx.scalar(
        f"SELECT COUNT(*) FROM stock_fundamentals f WHERE {all_null}") or 0)
    if not n:
        return None
    # The ones that matter: an empty row that is the *newest* for its stock,
    # because DISTINCT ON picks it and hides the last good snapshot.
    masking = ctx.query_dicts(f"""
        SELECT s.ticker, f.snapshot_date
          FROM current_fundamentals f JOIN stocks s ON s.id = f.stock_id
         WHERE {all_null}
         ORDER BY s.ticker LIMIT %s
    """, (ctx.sample_limit,)) if "current_fundamentals" in ctx.views else []
    n_masking = int(ctx.scalar(
        f"SELECT COUNT(*) FROM current_fundamentals f WHERE {all_null}") or 0) \
        if "current_fundamentals" in ctx.views else 0
    ratio = n / total
    status = Status.FAIL if n_masking else (
        Status.WARN if ratio > ctx.t.null_snapshot_pct_warn else Status.INFO)
    return Finding(
        "fund.empty_snapshots", "fundamentals", "Snapshots are not empty shells",
        status,
        f"{n:,}/{total:,} ({pct(ratio)}) snapshots are entirely NULL; "
        f"{n_masking} of them are the newest row for their stock and are "
        f"masking older good data",
        metrics={"empty": n, "total": total, "masking_current": n_masking},
        samples=masking,
        remediation="Delete the empty rows so current_fundamentals falls back "
                    "to the last good snapshot:\n"
                    f"  DELETE FROM stock_fundamentals f WHERE "
                    f"{all_null.replace('f.', '')};\n"
                    "Then re-run update_stock_data.py --fundamentals-only.",
    )


@check("fund.future_snapshots", "fundamentals", "No future-dated snapshots",
       min_profile="standard")
def check_future_snapshots(ctx: Context):
    if not ctx.has_table("stock_fundamentals"):
        return Finding("fund.future_snapshots", "fundamentals",
                       "No future-dated snapshots", Status.SKIP,
                       "stock_fundamentals not present")
    rows = ctx.query_dicts("""
        SELECT s.ticker, f.snapshot_date
          FROM stock_fundamentals f JOIN stocks s ON s.id = f.stock_id
         WHERE f.snapshot_date > CURRENT_DATE
         ORDER BY f.snapshot_date DESC LIMIT 500
    """)
    if not rows:
        return None
    return Finding(
        "fund.future_snapshots", "fundamentals", "No future-dated snapshots",
        Status.FAIL,
        f"{len(rows)} fundamentals snapshot(s) dated in the future",
        metrics={"count": len(rows)}, samples=rows[:ctx.sample_limit],
        remediation="Future-dated snapshots leak lookahead into any "
                    "point-in-time backtest that filters snapshot_date <= "
                    "eval_date, and they permanently win the DISTINCT ON in "
                    "current_fundamentals. Delete them.",
    )


# ──────────────────────────────────────────────────────────────────────────────
# Index membership
# ──────────────────────────────────────────────────────────────────────────────

@check("idx.member_counts", "indices", "Index member counts are plausible",
       min_profile="quick")
def check_member_counts(ctx: Context):
    rows = ctx.query_dicts("""
        SELECT i.symbol,
               COUNT(*) FILTER (WHERE m.is_active)     AS active,
               COUNT(*) FILTER (WHERE NOT m.is_active) AS inactive
          FROM stock_indices i
          LEFT JOIN stock_index_members m ON m.index_id = i.id
         GROUP BY i.symbol ORDER BY i.symbol
    """)
    bad = []
    for r in rows:
        bounds = ctx.t.index_member_bounds.get(r["symbol"])
        if not bounds:
            continue
        lo, hi = bounds
        if not (lo <= r["active"] <= hi):
            bad.append({"index": r["symbol"], "active": r["active"],
                        "expected": f"{lo}-{hi}",
                        "direction": "low" if r["active"] < lo else "high"})
    if not bad:
        return Finding(
            "idx.member_counts", "indices", "Index member counts are plausible",
            Status.PASS,
            f"all {len(rows)} index(es) within expected member ranges",
            metrics={"per_index": {r["symbol"]: r["active"] for r in rows}},
        )
    return Finding(
        "idx.member_counts", "indices", "Index member counts are plausible",
        Status.WARN,
        f"{len(bad)} index(es) outside their expected member count",
        metrics={"per_index": {r["symbol"]: r["active"] for r in rows}},
        samples=bad,
        remediation="A short index means the Wikipedia/iShares loader partly "
                    "failed and the reconciliation marked real members "
                    "inactive. Re-run update_stock_data.py --memberships-only "
                    "and re-check before trusting any universe-wide screen.",
    )


@check("idx.duplicate_members", "indices", "No duplicate active memberships",
       min_profile="standard")
def check_duplicate_members(ctx: Context):
    rows = ctx.query_dicts("""
        SELECT i.symbol, s.ticker, COUNT(*) AS n
          FROM stock_index_members m
          JOIN stocks s ON s.id = m.stock_id
          JOIN stock_indices i ON i.id = m.index_id
         WHERE m.is_active
         GROUP BY i.symbol, s.ticker
        HAVING COUNT(*) > 1
         ORDER BY COUNT(*) DESC LIMIT 500
    """)
    if not rows:
        return None
    return Finding(
        "idx.duplicate_members", "indices", "No duplicate active memberships",
        Status.FAIL,
        f"{len(rows)} (index, ticker) pair(s) have more than one active row",
        metrics={"count": len(rows)}, samples=rows[:ctx.sample_limit],
        remediation="Duplicates double-weight the name in any equal-weight "
                    "universe construction. Deduplicate and add a unique "
                    "constraint on (stock_id, index_id).",
    )


@check("idx.inactive_but_traded", "indices",
       "Active members are actually tradeable", min_profile="standard")
def check_active_members_tradeable(ctx: Context):
    """Active index members with no recent price at all.

    Either the name was delisted and never marked inactive (so backtests keep
    "holding" a ghost), or the price feed lost it.
    """
    cal = ctx.calendar
    if not cal:
        return Finding("idx.inactive_but_traded", "indices",
                       "Active members are actually tradeable", Status.SKIP,
                       "no trading calendar available")
    cutoff = cal[-min(20, len(cal))]
    rows = ctx.query_dicts("""
        SELECT i.symbol, s.ticker, MAX(p.date) AS last_price
          FROM stock_index_members m
          JOIN stocks s ON s.id = m.stock_id
          JOIN stock_indices i ON i.id = m.index_id
          LEFT JOIN price_data p ON p.stock_id = s.id
         WHERE m.is_active
         GROUP BY i.symbol, s.ticker
        HAVING MAX(p.date) IS NULL OR MAX(p.date) < %s
         ORDER BY MAX(p.date) NULLS FIRST LIMIT 500
    """, (cutoff,))
    if not rows:
        return None
    return Finding(
        "idx.inactive_but_traded", "indices",
        "Active members are actually tradeable", Status.WARN,
        f"{len(rows)} active index membership(s) have no price since {cutoff}",
        metrics={"count": len(rows), "cutoff": cutoff},
        samples=rows[:ctx.sample_limit],
        remediation="Mark genuinely delisted names is_active = false — "
                    "otherwise the screener keeps ranking a ghost and a "
                    "backtest can 'hold' a position that cannot be exited.",
    )
