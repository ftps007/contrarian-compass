"""Database-wide, full-history coverage checks.

Everything else in the suite grades the *simulation universe* over a bounded
window. These checks grade **every ticker in `stocks` over its entire recorded
history** — the majority of the 36M rows, and the part a future backtest will
read once point-in-time membership pulls in names that are not in today's
index.

The census itself lives in `inventory.py`; these are the report-facing views
of it. It runs once per invocation and is cached, so the three checks below
share a single set of scans.
"""

from __future__ import annotations

from .core import Context, Finding, Status, check, escalate_age, pct
from .inventory import GRADE_MEANING, build_inventory, summarise


def _inventory(ctx: Context, deep: bool | None = None):
    """One census per run, shared by every check in this module.

    Keyed by depth: a shallow census skips the gap and split-artifact scans,
    so it must not be handed back to a caller that asked for a deep one.
    """
    if deep is None:
        deep = ctx.profile == "deep"
    return ctx.cached(f"inventory:deep={deep}",
                      lambda: build_inventory(ctx, deep=deep))


@check("inv.census", "inventory",
       "Full-database, full-history coverage census", min_profile="standard",
       heavy=True)
def check_census(ctx: Context):
    inv = _inventory(ctx)
    if not inv:
        return Finding("inv.census", "inventory",
                       "Full-database, full-history coverage census",
                       Status.SKIP, "no tickers in stocks")
    s = summarise(inv)
    grades = s["grades"]
    bad = sum(grades[g] for g in ("EMPTY", "CORRUPT", "GAPPY", "THIN"))
    ratio = bad / len(inv)
    status = escalate_age(ratio, ctx.t.inventory_bad_pct_warn,
                          ctx.t.inventory_bad_pct_fail)

    worst = sorted(
        (c for c in inv if c.grade not in ("OK", "APPROX")),
        key=lambda c: (c.completeness, -c.defects))[:ctx.sample_limit]

    mix = ", ".join(f"{g}={grades[g]:,}" for g in
                    ("OK", "APPROX", "THIN", "STALE", "GAPPY", "CORRUPT", "EMPTY")
                    if grades[g])
    return Finding(
        "inv.census", "inventory", "Full-database, full-history coverage census",
        status,
        f"{len(inv):,} tickers, {s['total_rows']:,} price rows spanning "
        f"{s['earliest']} → {s['latest']}; {bad:,} ({pct(ratio)}) graded "
        f"EMPTY/CORRUPT/GAPPY/THIN. Grade mix: {mix}",
        metrics={**s, "bad": bad, "bad_ratio": round(ratio, 4),
                 "profile_deep": ctx.profile == "deep",
                 "grade_meanings": GRADE_MEANING},
        samples=[{"ticker": c.ticker, "grade": c.grade,
                  "first": c.first_date, "last": c.last_date,
                  "closes": c.closes, "expected": c.expected_sessions,
                  "completeness": c.completeness, "defects": c.defects,
                  "indices": c.indices or "-",
                  "why": "; ".join(c.reasons)} for c in worst],
        remediation="Export the full per-ticker table to inspect all of them:\n"
                    "  python db_health_check.py --coverage-report coverage.csv\n"
                    "Grades: EMPTY (no rows) · CORRUPT (split artifacts or "
                    "invalid bars) · GAPPY (missing sessions inside its own "
                    "span) · STALE (no recent bar — often a legitimate "
                    "delisting) · THIN (too few closes to backtest) · APPROX "
                    "(clean, but starts before the calendar rules are reliable)."
                    + ("\nRun with --profile deep to include the gap and "
                       "split-artifact scans, which are skipped here."
                       if ctx.profile != "deep" else ""),
    )


@check("inv.full_history_gaps", "inventory",
       "No large gaps anywhere in the database", min_profile="deep",
       heavy=True)
def check_full_history_gaps(ctx: Context):
    """Contiguous runs of missing sessions, across every ticker's whole series.

    Interior gaps never self-heal — `update_stock_data.py` fetches from each
    ticker's `MAX(date)` forward, so a hole behind the newest row survives every
    subsequent run. Finding them requires looking at the full history, not a
    trailing window, which is exactly what the window-scoped checks cannot do.
    """
    inv = _inventory(ctx)
    gappy = [c for c in inv
             if c.largest_gap_sessions >= ctx.t.max_acceptable_gap_sessions]
    if not gappy:
        return None
    total_missing = sum(c.missing_sessions for c in inv
                        if not c.completeness_approximate)
    in_index = [c for c in gappy if c.indices]
    gappy.sort(key=lambda c: -c.largest_gap_sessions)
    return Finding(
        "inv.full_history_gaps", "inventory",
        "No large gaps anywhere in the database",
        Status.FAIL if in_index else Status.WARN,
        f"{len(gappy):,} ticker(s) carry a gap of >= "
        f"{ctx.t.max_acceptable_gap_sessions} sessions somewhere in their "
        f"history ({len(in_index):,} are active index members); "
        f"{total_missing:,} missing sessions database-wide",
        metrics={"tickers_with_large_gaps": len(gappy),
                 "in_active_index": len(in_index),
                 "total_missing_sessions": total_missing,
                 "largest": gappy[0].largest_gap_sessions},
        samples=[{"ticker": c.ticker, "gap_sessions": c.largest_gap_sessions,
                  "from": c.largest_gap_start, "to": c.largest_gap_end,
                  "gaps": c.gap_count, "indices": c.indices or "-"}
                 for c in gappy[:ctx.sample_limit]],
        remediation="Backfill each affected ticker from the start of its "
                    "earliest gap — the updater will not do it on its own:\n"
                    "  python update_stock_data.py --prices-only --since <gap start>\n"
                    "Prioritise the active index members; a gap in a delisted "
                    "name only matters if a point-in-time backtest reaches it.",
    )


@check("inv.orphan_tickers", "inventory",
       "Tickers outside any index still have usable history",
       min_profile="standard")
def check_orphan_tickers(ctx: Context):
    """Coverage of the ~8k tickers that are in `stocks` but in no active index.

    Easy to dismiss as irrelevant — they are not in today's screener universe.
    But `sp500_members_at()` deliberately reaches back to names that have since
    been removed, so a point-in-time backtest *will* try to price them. Their
    coverage is the difference between a survivorship-free backtest and one
    that silently drops every deleted constituent.
    """
    inv = _inventory(ctx)
    orphans = [c for c in inv if not c.indices]
    if not orphans:
        return None
    unusable = [c for c in orphans if c.grade in ("EMPTY", "CORRUPT", "THIN")]
    ratio = len(unusable) / len(orphans)
    return Finding(
        "inv.orphan_tickers", "inventory",
        "Tickers outside any index still have usable history",
        Status.WARN if ratio > ctx.t.inventory_bad_pct_warn else Status.INFO,
        f"{len(orphans):,} ticker(s) belong to no active index; "
        f"{len(unusable):,} ({pct(ratio)}) of those are EMPTY, CORRUPT or THIN",
        metrics={"orphans": len(orphans), "unusable": len(unusable),
                 "ratio": round(ratio, 4)},
        samples=[{"ticker": c.ticker, "grade": c.grade, "closes": c.closes,
                  "first": c.first_date, "last": c.last_date,
                  "why": "; ".join(c.reasons)}
                 for c in sorted(unusable, key=lambda c: c.ticker)[:ctx.sample_limit]],
        remediation="These are the historical constituents a point-in-time "
                    "backtest reaches for. Where their history is unusable, "
                    "sp500_members_at() returns a ticker the backtest cannot "
                    "price, and it gets silently dropped — reintroducing the "
                    "survivorship bias the history table exists to remove.",
    )
