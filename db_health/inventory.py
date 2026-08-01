"""Per-ticker coverage census across the entire database.

The universe-scoped checks answer "is the panel I am about to simulate on
sound?". This module answers the broader question: **for every single ticker in
`stocks`, over its whole recorded history, what does its coverage actually look
like?**

That is a different and larger question. A ticker outside today's index
membership is still traded by any backtest that reconstructs point-in-time
membership, and its history is still the thing a future simulation will read.
Grading only the current universe over a 750-day window leaves the majority of
the 36M rows unexamined.

The census is built from a small number of set-based aggregates rather than
per-ticker queries — four passes over `price_data` regardless of whether the
database holds 40 tickers or 11,000.

## A caveat about very old history

Expected-session counts come from the modern NYSE rule set in
`nyse_calendar.py`. That rule set is wrong before 1952, when the exchange also
traded Saturday mornings, and holiday practice differed earlier still. For a
series starting before `calendar_reliable_from` (default 1970-01-01) the
completeness ratio is therefore marked *approximate* rather than reported as a
precise defect — observed can legitimately exceed expected there. Freshness,
gap and corruption metrics stay exact at any age; only the expected-session
denominator is affected.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass, field, asdict
from datetime import date
from typing import Any, Iterable

from . import nyse_calendar as nyse
from .core import Context

# Grades, worst first. A ticker gets the worst grade it qualifies for.
GRADE_ORDER = ["EMPTY", "CORRUPT", "GAPPY", "STALE", "THIN", "APPROX", "OK"]

GRADE_MEANING = {
    "EMPTY":   "no price rows at all",
    "CORRUPT": "split artifacts, invalid bars or bad prices in the series",
    "GAPPY":   "missing sessions inside its own first..last span",
    "STALE":   "no bar since the freshness cutoff (may be a legitimate delisting)",
    "THIN":    "fewer closes than the minimum a backtest needs",
    "APPROX":  "clean, but starts before the calendar rules are reliable",
    "OK":      "complete and current",
}


@dataclass
class TickerCoverage:
    stock_id: int
    ticker: str
    name: str | None = None
    exchange: str | None = None
    sector: str | None = None
    indices: str = ""                    # pipe-separated active memberships

    first_date: date | None = None
    last_date: date | None = None
    rows: int = 0
    closes: int = 0                      # rows with a non-NULL close

    expected_sessions: int = 0
    missing_sessions: int = 0
    completeness: float = 0.0
    completeness_approximate: bool = False

    gap_count: int = 0                   # runs of >=1 missing session
    largest_gap_sessions: int = 0
    largest_gap_start: date | None = None
    largest_gap_end: date | None = None

    sessions_stale: int = 0              # behind the newest bar in the DB

    null_closes: int = 0
    null_adj_closes: int = 0
    bad_prices: int = 0                  # non-positive or out of bounds
    neg_volume: int = 0
    ohlc_violations: int = 0
    calendar_violations: int = 0         # weekend / future-dated
    split_artifacts: int = 0
    adj_factor_latest: float | None = None

    grade: str = "OK"
    reasons: list[str] = field(default_factory=list)

    @property
    def defects(self) -> int:
        return (self.null_closes + self.bad_prices + self.neg_volume
                + self.ohlc_violations + self.calendar_violations
                + self.split_artifacts)

    def to_row(self) -> dict[str, Any]:
        d = asdict(self)
        d["reasons"] = "; ".join(self.reasons)
        d["defects"] = self.defects
        return d


CSV_COLUMNS = [
    "ticker", "stock_id", "name", "exchange", "sector", "indices",
    "grade", "reasons",
    "first_date", "last_date", "rows", "closes",
    "expected_sessions", "missing_sessions", "completeness",
    "completeness_approximate",
    "gap_count", "largest_gap_sessions", "largest_gap_start", "largest_gap_end",
    "sessions_stale",
    "defects", "null_closes", "null_adj_closes", "bad_prices", "neg_volume",
    "ohlc_violations", "calendar_violations", "split_artifacts",
    "adj_factor_latest",
]


class _SessionIndex:
    """Counts NYSE sessions in a date range in O(log n) via bisect."""

    def __init__(self, start: date, end: date):
        self.sessions = nyse.trading_days(start, end)

    def count(self, lo: date, hi: date) -> int:
        """Sessions in [lo, hi] inclusive."""
        if lo is None or hi is None or hi < lo:
            return 0
        i = bisect.bisect_left(self.sessions, lo)
        j = bisect.bisect_right(self.sessions, hi)
        return j - i


def build_inventory(ctx: Context, *, deep: bool = True,
                    tickers: Iterable[str] | None = None,
                    progress=None) -> list[TickerCoverage]:
    """Build the per-ticker census.

    `deep=False` skips the two window-function passes (gaps and split
    artifacts), which are the expensive ones on a 36M-row table.
    """
    def say(msg: str) -> None:
        if progress:
            progress(msg)

    cols = ctx.columns("stocks")
    where = "s.ticker IS NOT NULL AND s.ticker <> ''"
    if "test_issue" in cols:
        where += " AND s.test_issue IS DISTINCT FROM 'Y'"
    params: dict[str, Any] = {}
    if tickers:
        where += " AND s.ticker = ANY(%(tickers)s)"
        params["tickers"] = list(tickers)

    say("stock inventory")
    by_id: dict[int, TickerCoverage] = {}
    for r in ctx.query_dicts(f"""
        SELECT s.id, s.ticker, s.name, s.exchange, s.sector,
               COALESCE(string_agg(DISTINCT i.symbol, '|' ORDER BY i.symbol), '')
                 AS indices
          FROM stocks s
          LEFT JOIN stock_index_members m
                 ON m.stock_id = s.id AND m.is_active
          LEFT JOIN stock_indices i ON i.id = m.index_id
         WHERE {where}
         GROUP BY s.id, s.ticker, s.name, s.exchange, s.sector
    """, params):
        by_id[r["id"]] = TickerCoverage(
            stock_id=r["id"], ticker=r["ticker"], name=r["name"],
            exchange=r["exchange"], sector=r["sector"], indices=r["indices"])

    if not by_id:
        return []

    ids = list(by_id)

    # ---- pass 1: per-stock aggregates over the whole series ----------------
    say(f"aggregating price history for {len(ids):,} tickers")
    for r in ctx.query_dicts("""
        SELECT p.stock_id,
               MIN(p.date) AS first_date,
               MAX(p.date) AS last_date,
               COUNT(*) AS rows,
               COUNT(p.close) AS closes,
               COUNT(*) FILTER (WHERE p.close IS NULL) AS null_closes,
               COUNT(*) FILTER (WHERE p.close IS NOT NULL
                                  AND p.adj_close IS NULL) AS null_adj,
               COUNT(*) FILTER (WHERE p.close <= 0 OR p.open <= 0
                                  OR p.high <= 0 OR p.low <= 0
                                  OR p.close > %(ceiling)s) AS bad_prices,
               COUNT(*) FILTER (WHERE p.volume < 0) AS neg_volume,
               COUNT(*) FILTER (WHERE p.high < p.low
                                  OR (p.open IS NOT NULL AND p.close IS NOT NULL
                                      AND (p.high < GREATEST(p.open, p.close)
                                        OR p.low  > LEAST(p.open, p.close)))
                               ) AS ohlc_violations,
               COUNT(*) FILTER (WHERE EXTRACT(ISODOW FROM p.date) IN (6, 7)
                                  OR p.date > CURRENT_DATE) AS calendar_violations
          FROM price_data p
         WHERE p.stock_id = ANY(%(ids)s)
         GROUP BY p.stock_id
    """, {"ids": ids, "ceiling": ctx.t.price_ceiling}):
        c = by_id[r["stock_id"]]
        c.first_date = r["first_date"]
        c.last_date = r["last_date"]
        c.rows = r["rows"]
        c.closes = r["closes"]
        c.null_closes = r["null_closes"]
        c.null_adj_closes = r["null_adj"]
        c.bad_prices = r["bad_prices"]
        c.neg_volume = r["neg_volume"]
        c.ohlc_violations = r["ohlc_violations"]
        c.calendar_violations = r["calendar_violations"]

    # ---- pass 2: latest adjustment factor ----------------------------------
    say("adjustment factors")
    for r in ctx.query_dicts("""
        SELECT DISTINCT ON (p.stock_id) p.stock_id,
               (p.adj_close / p.close) AS factor
          FROM price_data p
         WHERE p.stock_id = ANY(%s) AND p.close > 0 AND p.adj_close IS NOT NULL
         ORDER BY p.stock_id, p.date DESC
    """, (ids,)):
        by_id[r["stock_id"]].adj_factor_latest = round(float(r["factor"]), 5)

    # ---- pass 3: gaps, full history ----------------------------------------
    # Prefilter in SQL on calendar distance (a normal Fri->Mon is 3 days, a
    # long weekend 4), then resolve the exact session count in Python. Keeps
    # the NYSE rules in one place instead of reimplementing them in SQL.
    if deep:
        say("gap analysis (window scan over full history)")
        gap_rows = ctx.query_dicts("""
            WITH d AS (
                SELECT stock_id, date,
                       LAG(date) OVER (PARTITION BY stock_id ORDER BY date) AS prev
                  FROM price_data
                 WHERE stock_id = ANY(%s) AND close IS NOT NULL
            )
            SELECT stock_id, prev AS gap_start, date AS gap_end,
                   (date - prev) AS cal_days
              FROM d
             WHERE prev IS NOT NULL AND (date - prev) > 4
        """, (ids,))
    else:
        gap_rows = []

    # ---- pass 4: split artifacts, full history -----------------------------
    if deep:
        say("split-artifact scan (window scan over full history)")
        from .checks_integrity import _split_ratio_sql
        tol = ctx.t.split_ratio_tolerance
        for r in ctx.query_dicts(f"""
            WITH w AS (
                SELECT stock_id, date, close,
                       LAG(close) OVER (PARTITION BY stock_id ORDER BY date) AS prev_close
                  FROM price_data
                 WHERE stock_id = ANY(%s) AND close IS NOT NULL AND close > 0
            ),
            r AS (
                SELECT stock_id, close / prev_close AS ratio
                  FROM w WHERE prev_close IS NOT NULL AND prev_close > 0
            )
            SELECT stock_id, COUNT(*) AS n
              FROM r
             WHERE abs(ratio - 1) >= %s AND {_split_ratio_sql('ratio', tol)}
             GROUP BY stock_id
        """, (ids, ctx.t.split_return_threshold)):
            by_id[r["stock_id"]].split_artifacts = r["n"]

    # ---- derive session-based metrics --------------------------------------
    say("computing expected sessions")
    spans = [c for c in by_id.values() if c.first_date and c.last_date]
    if spans:
        cal = _SessionIndex(min(c.first_date for c in spans),
                            max(max(c.last_date for c in spans), ctx.today))
    else:
        cal = _SessionIndex(ctx.today, ctx.today)

    # Resolve prefiltered gaps into exact session counts.
    per_stock_gaps: dict[int, list[tuple[int, date, date]]] = {}
    for g in gap_rows:
        missing = cal.count(g["gap_start"], g["gap_end"]) - 2  # exclude endpoints
        if missing > 0:
            per_stock_gaps.setdefault(g["stock_id"], []).append(
                (missing, g["gap_start"], g["gap_end"]))

    db_last = ctx.scalar("SELECT MAX(date) FROM price_data WHERE date <= CURRENT_DATE")
    reliable_from = ctx.t.calendar_reliable_from

    for c in by_id.values():
        if c.first_date and c.last_date:
            c.expected_sessions = cal.count(c.first_date, c.last_date)
            c.completeness_approximate = c.first_date < reliable_from
            if c.expected_sessions:
                raw = c.closes / c.expected_sessions
                c.completeness = round(min(raw, 1.0), 4)
                c.missing_sessions = max(0, c.expected_sessions - c.closes)
            if db_last:
                c.sessions_stale = nyse.sessions_between(c.last_date, db_last)

        gaps = per_stock_gaps.get(c.stock_id, [])
        if gaps:
            c.gap_count = len(gaps)
            biggest = max(gaps)
            c.largest_gap_sessions, c.largest_gap_start, c.largest_gap_end = biggest

    for c in by_id.values():
        _grade(c, ctx)

    return sorted(by_id.values(), key=lambda c: c.ticker)


def _grade(c: TickerCoverage, ctx: Context) -> None:
    """Assign the worst grade the ticker qualifies for, with reasons."""
    t = ctx.t
    reasons: list[str] = []
    grade = "OK"

    def worse(g: str) -> None:
        nonlocal grade
        if GRADE_ORDER.index(g) < GRADE_ORDER.index(grade):
            grade = g

    if c.rows == 0:
        c.grade = "EMPTY"
        c.reasons = ["no price rows"]
        return

    if c.split_artifacts:
        worse("CORRUPT")
        reasons.append(f"{c.split_artifacts} split-shaped discontinuity(ies)")
    if c.ohlc_violations:
        worse("CORRUPT")
        reasons.append(f"{c.ohlc_violations} invalid OHLC bar(s)")
    if c.bad_prices:
        worse("CORRUPT")
        reasons.append(f"{c.bad_prices} non-positive/implausible price(s)")
    if c.neg_volume:
        worse("CORRUPT")
        reasons.append(f"{c.neg_volume} negative-volume row(s)")
    if c.null_closes:
        # A NULL close occupies its (stock_id, date) slot, so ON CONFLICT DO
        # NOTHING can never replace it with the real bar.
        worse("CORRUPT")
        reasons.append(f"{c.null_closes} NULL close(s) blocking a re-fetch")
    if c.calendar_violations:
        worse("CORRUPT")
        reasons.append(f"{c.calendar_violations} weekend/future-dated row(s)")
    if c.adj_factor_latest is not None and \
            abs(c.adj_factor_latest - 1) > t.adj_factor_tolerance:
        worse("CORRUPT")
        reasons.append(f"latest adj_close/close = {c.adj_factor_latest}")

    # The completeness *ratio* is only meaningful where the calendar rules are
    # trustworthy and the denominator is big enough not to be noise — on a
    # 40-session series a single missing day reads as 2.5% incomplete. Short
    # series are graded THIN instead, and the absolute gap rule below still
    # applies to them.
    ratio_meaningful = (not c.completeness_approximate
                        and c.expected_sessions >= t.min_history_rows)
    if ratio_meaningful and c.completeness < t.panel_completeness_warn:
        worse("GAPPY")
        reasons.append(f"{c.missing_sessions} missing session(s) "
                       f"({c.completeness:.1%} complete)")
    elif c.largest_gap_sessions >= t.max_acceptable_gap_sessions:
        worse("GAPPY")
        reasons.append(f"{c.largest_gap_sessions}-session gap "
                       f"{c.largest_gap_start}→{c.largest_gap_end}")

    if c.sessions_stale > t.stale_ticker_lag_days:
        worse("STALE")
        reasons.append(f"{c.sessions_stale} session(s) behind the newest bar")

    if c.closes < t.min_history_rows:
        worse("THIN")
        reasons.append(f"only {c.closes} close(s), below the "
                       f"{t.min_history_rows} a backtest needs")

    if grade == "OK" and c.completeness_approximate:
        grade = "APPROX"
        reasons.append(f"history starts {c.first_date}, before the calendar "
                       f"rules are reliable ({t.calendar_reliable_from})")

    c.grade = grade
    c.reasons = reasons


def summarise(inv: list[TickerCoverage]) -> dict[str, Any]:
    counts = {g: 0 for g in GRADE_ORDER}
    for c in inv:
        counts[c.grade] += 1
    graded = [c for c in inv if c.rows]
    exact = [c for c in graded if not c.completeness_approximate]
    return {
        "tickers": len(inv),
        "with_data": len(graded),
        "grades": counts,
        "total_rows": sum(c.rows for c in inv),
        "total_missing_sessions": sum(c.missing_sessions for c in exact),
        "total_defects": sum(c.defects for c in inv),
        "mean_completeness": (round(sum(c.completeness for c in exact) / len(exact), 4)
                              if exact else None),
        "earliest": min((c.first_date for c in graded if c.first_date), default=None),
        "latest": max((c.last_date for c in graded if c.last_date), default=None),
    }


def write_csv(inv: list[TickerCoverage], path: str) -> None:
    import csv
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        w.writeheader()
        for c in inv:
            w.writerow(c.to_row())


def write_json(inv: list[TickerCoverage], path: str) -> None:
    import json
    with open(path, "w") as fh:
        json.dump({"summary": summarise(inv),
                   "tickers": [c.to_row() for c in inv]},
                  fh, indent=2, default=str)
