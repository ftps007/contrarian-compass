"""Price integrity checks — is the data *correct*?

Two families live here:

1. **Validity** — invariants that must hold for any OHLC bar (high >= low,
   prices positive, no weekend rows). Cheap, unambiguous, always a defect.

2. **Corruption** — the subtle ones that silently ruin simulations. These
   matter most because of how `update_stock_data.py` writes prices:

       INSERT ... ON CONFLICT (stock_id, date) DO NOTHING

   A row, once written, is *never corrected*. When Yahoo retroactively
   re-adjusts a ticker's history for a split, the rows already in the table
   keep their pre-split values while newly-fetched rows arrive post-split.
   The series then contains a permanent artificial -50% (or -66%, -90%...)
   one-day return at the split date. Nothing errors. Every backtest that
   crosses that date silently books a fake loss, and a contrarian screener —
   which explicitly hunts for large drawdowns — will rank that fake crash as
   a top opportunity.

   That single failure mode is why this checker exists, and it is what
   `split_artifact`, `adj_factor_stale` and `adj_factor_monotone` target.
"""

from __future__ import annotations

from .core import Context, Finding, Status, check, escalate, pct

# Ratios a genuine split produces, as new/old close. Forward splits shrink the
# price (2:1 -> 0.5), reverse splits raise it. Anything landing within
# `split_ratio_tolerance` of one of these, on a day with an otherwise
# implausible return, is almost certainly an unapplied split rather than a
# real move.
SPLIT_RATIOS = [
    1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8, 1 / 10, 1 / 15, 1 / 20,
    1 / 25, 1 / 30, 1 / 50, 1 / 100,
    2 / 3, 3 / 4, 4 / 5, 5 / 6, 3 / 2, 4 / 3, 5 / 4, 5 / 3, 5 / 2,
    2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 10.0, 15.0, 20.0, 25.0, 30.0, 50.0, 100.0,
]


def _split_ratio_sql(alias: str, tol: float) -> str:
    """SQL boolean: does `alias` sit within `tol` (relative) of a split ratio?"""
    terms = " OR ".join(
        f"abs({alias} - {r!r}) <= {r!r} * {tol!r}" for r in SPLIT_RATIOS
    )
    return f"({terms})"


# ──────────────────────────────────────────────────────────────────────────────
# Validity
# ──────────────────────────────────────────────────────────────────────────────

@check("valid.ohlc", "validity", "OHLC bars are internally consistent",
       min_profile="standard", heavy=True)
def check_ohlc_consistency(ctx: Context):
    """high >= low, and high/low actually bound open and close.

    A bar that violates this is corrupt at the source. It matters beyond
    tidiness: stop_loss_engine.py and the drawdown factors read highs and lows,
    so an inverted bar can trigger a phantom stop.
    """
    rows = ctx.query_dicts("""
        SELECT s.ticker, p.date, p.open, p.high, p.low, p.close,
               CASE
                 WHEN p.high < p.low THEN 'high < low'
                 WHEN p.high < GREATEST(p.open, p.close) THEN 'high below open/close'
                 WHEN p.low  > LEAST(p.open, p.close)    THEN 'low above open/close'
               END AS violation
          FROM price_data p JOIN stocks s ON s.id = p.stock_id
         WHERE p.date >= %s
           AND p.high IS NOT NULL AND p.low IS NOT NULL
           AND (p.high < p.low
                OR (p.open IS NOT NULL AND p.close IS NOT NULL
                    AND (p.high < GREATEST(p.open, p.close)
                         OR p.low > LEAST(p.open, p.close))))
         ORDER BY p.date DESC
         LIMIT 5000
    """, (ctx.window_start,))
    if not rows:
        return None
    return Finding(
        "valid.ohlc", "validity", "OHLC bars are internally consistent",
        escalate(len(rows), ctx.t.ohlc_violation_warn, ctx.t.ohlc_violation_fail),
        f"{len(rows):,} bar(s) violate high/low bounds in the last "
        f"{ctx.window_days}d",
        metrics={"count": len(rows), "capped_at": 5000},
        samples=rows[:ctx.sample_limit],
        remediation="Delete and re-fetch the affected (stock_id, date) rows — "
                    "ON CONFLICT DO NOTHING means a plain re-run will NOT "
                    "overwrite them:\n"
                    "  DELETE FROM price_data WHERE stock_id = <id> AND date = '<d>';\n"
                    "  python update_stock_data.py --prices-only --since <d>",
    )


@check("valid.price_range", "validity", "Prices are within plausible bounds",
       min_profile="standard", heavy=True)
def check_price_range(ctx: Context):
    rows = ctx.query_dicts("""
        SELECT s.ticker, p.date, p.open, p.high, p.low, p.close, p.adj_close,
               CASE
                 WHEN p.close <= 0 THEN 'close <= 0'
                 WHEN p.close < %s THEN 'close below floor'
                 WHEN p.close > %s THEN 'close above ceiling'
                 WHEN p.open <= 0 OR p.high <= 0 OR p.low <= 0 THEN 'non-positive OHL'
                 WHEN p.adj_close <= 0 THEN 'adj_close <= 0'
               END AS violation
          FROM price_data p JOIN stocks s ON s.id = p.stock_id
         WHERE p.date >= %s
           AND (p.close <= 0 OR p.close < %s OR p.close > %s
                OR p.open <= 0 OR p.high <= 0 OR p.low <= 0
                OR p.adj_close <= 0)
         ORDER BY p.date DESC
         LIMIT 5000
    """, (ctx.t.price_floor, ctx.t.price_ceiling, ctx.window_start,
          ctx.t.price_floor, ctx.t.price_ceiling))
    if not rows:
        return None
    return Finding(
        "valid.price_range", "validity", "Prices are within plausible bounds",
        escalate(len(rows), ctx.t.ohlc_violation_warn, ctx.t.ohlc_violation_fail),
        f"{len(rows):,} row(s) with non-positive or implausible prices",
        metrics={"count": len(rows), "floor": ctx.t.price_floor,
                 "ceiling": ctx.t.price_ceiling},
        samples=rows[:ctx.sample_limit],
        remediation="A zero or negative close produces an infinite or complex "
                    "log-return and will poison beta, volatility and Sharpe for "
                    "the whole panel. Delete and re-fetch those rows.",
    )


@check("valid.null_close", "validity", "No NULL closes", min_profile="standard",
       heavy=True)
def check_null_close(ctx: Context):
    """_insert_price_batch skips NaN closes for multi-ticker downloads but the
    single-ticker path does not, so NULL closes can reach the table."""
    n = int(ctx.scalar("""
        SELECT COUNT(*) FROM price_data WHERE date >= %s AND close IS NULL
    """, (ctx.window_start,)) or 0)
    if not n:
        return None
    samples = ctx.query_dicts("""
        SELECT s.ticker, p.date, p.open, p.close, p.volume
          FROM price_data p JOIN stocks s ON s.id = p.stock_id
         WHERE p.date >= %s AND p.close IS NULL
         ORDER BY p.date DESC LIMIT %s
    """, (ctx.window_start, ctx.sample_limit))
    return Finding(
        "valid.null_close", "validity", "No NULL closes",
        escalate(n, 0, ctx.t.ohlc_violation_fail),
        f"{n:,} row(s) with a NULL close in {ctx.window_label}",
        metrics={"count": n}, samples=samples,
        remediation="These occupy a (stock_id, date) slot, so ON CONFLICT DO "
                    "NOTHING will never replace them with the real bar — the "
                    "day is permanently lost for that ticker unless the row is "
                    "deleted first.",
    )


@check("valid.null_adj_close", "validity", "adj_close is populated",
       min_profile="standard", heavy=True)
def check_null_adj_close(ctx: Context):
    n = int(ctx.scalar("""
        SELECT COUNT(*) FROM price_data
         WHERE date >= %s AND close IS NOT NULL AND adj_close IS NULL
    """, (ctx.window_start,)) or 0)
    if not n:
        return None
    total = int(ctx.scalar("SELECT COUNT(*) FROM price_data WHERE date >= %s",
                           (ctx.window_start,)) or 1)
    samples = ctx.query_dicts("""
        SELECT s.ticker, MIN(p.date) AS first_date, MAX(p.date) AS last_date,
               COUNT(*) AS rows
          FROM price_data p JOIN stocks s ON s.id = p.stock_id
         WHERE p.date >= %s AND p.close IS NOT NULL AND p.adj_close IS NULL
         GROUP BY s.ticker ORDER BY COUNT(*) DESC LIMIT %s
    """, (ctx.window_start, ctx.sample_limit))
    return Finding(
        "valid.null_adj_close", "validity", "adj_close is populated",
        Status.WARN,
        f"{n:,} row(s) ({pct(n / total)}) have a close but no adj_close",
        metrics={"count": n, "window_rows": total}, samples=samples,
        remediation="Total-return simulations need adj_close; without it a "
                    "dividend-paying holding's return is understated by its "
                    "whole yield. Note the screener backtests currently read "
                    "`close`, so this understates income return rather than "
                    "breaking outright.",
    )


@check("valid.volume", "validity", "Volume is sane", min_profile="standard",
       heavy=True)
def check_volume(ctx: Context):
    neg = int(ctx.scalar("""
        SELECT COUNT(*) FROM price_data WHERE date >= %s AND volume < 0
    """, (ctx.window_start,)) or 0)
    if not neg:
        return None
    samples = ctx.query_dicts("""
        SELECT s.ticker, p.date, p.volume, p.close
          FROM price_data p JOIN stocks s ON s.id = p.stock_id
         WHERE p.date >= %s AND p.volume < 0
         ORDER BY p.date DESC LIMIT %s
    """, (ctx.window_start, ctx.sample_limit))
    return Finding(
        "valid.volume", "validity", "Volume is sane", Status.FAIL,
        f"{neg:,} row(s) with negative volume", metrics={"count": neg},
        samples=samples,
        remediation="Negative volume indicates an integer overflow or a bad "
                    "feed row; liquidity filters in the screener will misbehave.",
    )


@check("valid.calendar_alignment", "validity", "No weekend or future rows",
       min_profile="standard", heavy=True)
def check_calendar_alignment(ctx: Context):
    rows = ctx.query_dicts("""
        SELECT s.ticker, p.date, p.close,
               CASE WHEN p.date > CURRENT_DATE THEN 'future-dated'
                    ELSE to_char(p.date, 'Day') END AS issue
          FROM price_data p JOIN stocks s ON s.id = p.stock_id
         WHERE p.date >= %s
           AND (EXTRACT(ISODOW FROM p.date) IN (6, 7) OR p.date > CURRENT_DATE)
         ORDER BY p.date DESC LIMIT 1000
    """, (ctx.window_start,))
    if not rows:
        return None
    future = [r for r in rows if r["issue"] == "future-dated"]
    return Finding(
        "valid.calendar_alignment", "validity", "No weekend or future rows",
        Status.FAIL if future else Status.WARN,
        f"{len(rows)} row(s) dated on a weekend or in the future "
        f"({len(future)} future-dated)",
        metrics={"count": len(rows), "future_dated": len(future)},
        samples=rows[:ctx.sample_limit],
        remediation="Future-dated rows break every 'as of' query in the "
                    "backtests (which filter date <= eval_date) and will leak "
                    "lookahead into results. Delete them.",
    )


# ──────────────────────────────────────────────────────────────────────────────
# Corruption — the simulation killers
# ──────────────────────────────────────────────────────────────────────────────

@check("corrupt.split_artifact", "corruption",
       "No unapplied stock-split artifacts", min_profile="standard", heavy=True)
def check_split_artifacts(ctx: Context):
    """One-day moves whose price ratio matches a clean split factor.

    Signature of the ON CONFLICT DO NOTHING trap described in the module
    docstring. Because Yahoo's `Close` is itself split-adjusted retroactively,
    a correctly-maintained series shows *no* split jump at all — so a jump that
    lands on 1/2, 1/3, 1/10 etc. is a stale-history artifact, not a real move.

    We separate two cases:
      * `close` and `adj_close` jump together  -> stale history, unapplied split
      * only `close` jumps                     -> adjustment applied unevenly
    Both are reported; the first is the common one.
    """
    tol = ctx.t.split_ratio_tolerance
    rows = ctx.query_dicts(f"""
        WITH w AS (
            SELECT p.stock_id, p.date, p.close, p.adj_close,
                   LAG(p.close)     OVER (PARTITION BY p.stock_id ORDER BY p.date) AS prev_close,
                   LAG(p.adj_close) OVER (PARTITION BY p.stock_id ORDER BY p.date) AS prev_adj,
                   LAG(p.date)      OVER (PARTITION BY p.stock_id ORDER BY p.date) AS prev_date
              FROM price_data p
             WHERE p.date >= %s AND p.close IS NOT NULL AND p.close > 0
        ),
        r AS (
            SELECT w.*, close / prev_close AS ratio,
                   CASE WHEN prev_adj > 0 THEN adj_close / prev_adj END AS adj_ratio
              FROM w WHERE prev_close IS NOT NULL AND prev_close > 0
        )
        SELECT s.ticker, r.date, r.prev_date, r.prev_close, r.close,
               round(r.ratio::numeric, 5) AS ratio,
               round(r.adj_ratio::numeric, 5) AS adj_ratio,
               round(((r.ratio - 1) * 100)::numeric, 2) AS pct_move,
               CASE WHEN r.adj_ratio IS NULL THEN 'no adj_close'
                    WHEN abs(r.adj_ratio - r.ratio) <= {tol!r} THEN 'stale history (close+adj jump together)'
                    ELSE 'uneven adjustment (close jumped, adj did not)'
               END AS pattern
          FROM r JOIN stocks s ON s.id = r.stock_id
         WHERE abs(r.ratio - 1) >= %s
           AND {_split_ratio_sql('r.ratio', tol)}
         ORDER BY abs(r.ratio - 1) DESC
         LIMIT 2000
    """, (ctx.window_start, ctx.t.split_return_threshold))
    if not rows:
        return None
    in_uni = {t for _, t in ctx.target_stocks}
    affected_universe = sorted({r["ticker"] for r in rows if r["ticker"] in in_uni})
    status = Status.FAIL if affected_universe else Status.WARN
    return Finding(
        "corrupt.split_artifact", "corruption",
        "No unapplied stock-split artifacts", status,
        f"{len(rows)} split-shaped price discontinuity(ies) across "
        f"{len({r['ticker'] for r in rows})} ticker(s); "
        f"{len(affected_universe)} are active {ctx.member_label}s",
        metrics={"count": len(rows),
                 "tickers": len({r["ticker"] for r in rows}),
                 "universe_tickers": affected_universe[:50]},
        samples=rows[:ctx.sample_limit],
        remediation="THIS IS THE ONE TO FIX FIRST. A stale split leaves a "
                    "permanent fake crash in the series, and a contrarian "
                    "screener hunting drawdowns will rank it as a top buy.\n"
                    "Because ON CONFLICT DO NOTHING never overwrites, a plain "
                    "re-run will not repair it. Per affected ticker:\n"
                    "  DELETE FROM price_data WHERE stock_id = "
                    "(SELECT id FROM stocks WHERE ticker = '<T>');\n"
                    "  python update_stock_data.py --prices-only --since 1990-01-01\n"
                    "Or use the bundled helper: "
                    "python -m db_health.repair --refetch <T> [--apply]",
    )


@check("corrupt.bad_ticks", "corruption", "No spike-and-revert bad ticks",
       min_profile="standard", heavy=True)
def check_bad_ticks(ctx: Context):
    """A day that jumps hugely and snaps back the next day.

    Real prices very rarely do this; feed glitches do it constantly. These
    inflate realised volatility, wreck beta estimates and can trigger phantom
    stop-losses in stop_loss_engine.py.
    """
    thr = ctx.t.bad_tick_return_threshold
    rev = ctx.t.bad_tick_revert_tolerance
    rows = ctx.query_dicts("""
        WITH w AS (
            SELECT p.stock_id, p.date, p.close,
                   LAG(p.close)  OVER (PARTITION BY p.stock_id ORDER BY p.date) AS prev_close,
                   LEAD(p.close) OVER (PARTITION BY p.stock_id ORDER BY p.date) AS next_close
              FROM price_data p
             WHERE p.date >= %s AND p.close IS NOT NULL AND p.close > 0
        )
        SELECT s.ticker, w.date, w.prev_close, w.close, w.next_close,
               round((((w.close / w.prev_close) - 1) * 100)::numeric, 2) AS spike_pct,
               round((((w.next_close / w.close) - 1) * 100)::numeric, 2) AS revert_pct
          FROM w JOIN stocks s ON s.id = w.stock_id
         WHERE w.prev_close > 0 AND w.next_close > 0
           -- big move out...
           AND abs(w.close / w.prev_close - 1) >= %s
           -- ...that comes back to within `rev` of where it started
           AND abs(w.next_close / w.prev_close - 1) <= %s
         ORDER BY abs(w.close / w.prev_close - 1) DESC
         LIMIT 2000
    """, (ctx.window_start, thr, rev))
    if not rows:
        return None
    return Finding(
        "corrupt.bad_ticks", "corruption", "No spike-and-revert bad ticks",
        Status.WARN,
        f"{len(rows)} single-day spike(s) of >={pct(thr)} that reverted within "
        f"{pct(rev)} the next session",
        metrics={"count": len(rows),
                 "tickers": len({r["ticker"] for r in rows})},
        samples=rows[:ctx.sample_limit],
        remediation="Almost always a bad print rather than a real move. Delete "
                    "and re-fetch the individual bars; leaving them in inflates "
                    "realised vol and can fire a phantom stop in "
                    "stop_loss_engine.py.",
    )


@check("corrupt.extreme_returns", "corruption", "No unexplained extreme moves",
       min_profile="standard", heavy=True)
def check_extreme_returns(ctx: Context):
    """Large one-day moves that are neither split-shaped nor reverting.

    Reported as INFO by default — real markets do produce these (biotech
    readouts, takeovers, bankruptcies). The value is having them listed so a
    human can eyeball whether the top of the list is plausible.
    """
    tol = ctx.t.split_ratio_tolerance
    rows = ctx.query_dicts(f"""
        WITH w AS (
            SELECT p.stock_id, p.date, p.close,
                   LAG(p.close)  OVER (PARTITION BY p.stock_id ORDER BY p.date) AS prev_close,
                   LEAD(p.close) OVER (PARTITION BY p.stock_id ORDER BY p.date) AS next_close
              FROM price_data p
             WHERE p.date >= %s AND p.close IS NOT NULL AND p.close > 0
        )
        SELECT s.ticker, w.date, w.prev_close, w.close,
               round((((w.close / w.prev_close) - 1) * 100)::numeric, 2) AS pct_move
          FROM w JOIN stocks s ON s.id = w.stock_id
         WHERE w.prev_close > 0
           AND abs(w.close / w.prev_close - 1) >= %s
           AND NOT {_split_ratio_sql('(w.close / w.prev_close)', tol)}
           AND (w.next_close IS NULL OR w.next_close <= 0
                OR abs(w.next_close / w.prev_close - 1) > %s)
         ORDER BY abs(w.close / w.prev_close - 1) DESC
         LIMIT 500
    """, (ctx.window_start, ctx.t.bad_tick_return_threshold,
          ctx.t.bad_tick_revert_tolerance))
    if not rows:
        return None
    return Finding(
        "corrupt.extreme_returns", "corruption", "No unexplained extreme moves",
        Status.INFO,
        f"{len(rows)} one-day move(s) >= {pct(ctx.t.bad_tick_return_threshold)} "
        f"that are not split-shaped and did not revert",
        metrics={"count": len(rows),
                 "tickers": len({r["ticker"] for r in rows})},
        samples=rows[:ctx.sample_limit],
        remediation="Review the largest by eye. Genuine (takeover, halt "
                    "reopening, bankruptcy) is fine and should stay. If a name "
                    "here is also in the screener's top ranks, confirm the "
                    "drawdown is real before trading it.",
    )


@check("corrupt.adj_factor_stale", "corruption",
       "Adjustment factors are current at the latest bar",
       min_profile="standard", heavy=True)
def check_adj_factor_stale(ctx: Context):
    """adj_close / close must be ~1.0 on a ticker's most recent bar.

    The adjustment factor accumulates all future dividends and splits, so it
    is 1.0 at the newest bar by construction. If it isn't, the most recent
    rows were written with an adjustment basis that has since moved — i.e. the
    series is mid-way through a stale re-adjustment.
    """
    tol = ctx.t.adj_factor_tolerance
    rows = ctx.query_dicts("""
        WITH latest AS (
            SELECT DISTINCT ON (p.stock_id)
                   p.stock_id, p.date, p.close, p.adj_close
              FROM price_data p
             WHERE p.date >= %s AND p.close > 0 AND p.adj_close IS NOT NULL
             ORDER BY p.stock_id, p.date DESC
        )
        SELECT s.ticker, l.date, l.close, l.adj_close,
               round((l.adj_close / l.close)::numeric, 5) AS adj_factor
          FROM latest l JOIN stocks s ON s.id = l.stock_id
         WHERE abs(l.adj_close / l.close - 1) > %s
         ORDER BY abs(l.adj_close / l.close - 1) DESC
         LIMIT 2000
    """, (ctx.window_start, tol))
    if not rows:
        return None
    in_uni = {t for _, t in ctx.target_stocks}
    hit_uni = [r for r in rows if r["ticker"] in in_uni]
    return Finding(
        "corrupt.adj_factor_stale", "corruption",
        "Adjustment factors are current at the latest bar",
        Status.FAIL if hit_uni else Status.WARN,
        f"{len(rows)} ticker(s) whose newest bar has adj_close/close outside "
        f"1±{tol} ({len(hit_uni)} in the {ctx.universe} universe)",
        metrics={"count": len(rows), "in_universe": len(hit_uni),
                 "tolerance": tol},
        samples=rows[:ctx.sample_limit],
        remediation="Strong indicator that the ticker's history is mid-split or "
                    "mid-re-adjustment. Cross-check against "
                    "corrupt.split_artifact — a ticker in both lists needs a "
                    "full delete-and-refetch.",
    )


@check("corrupt.adj_factor_monotone", "corruption",
       "Adjustment factors increase monotonically", min_profile="deep",
       heavy=True)
def check_adj_factor_monotone(ctx: Context):
    """adj_close/close must be non-decreasing as dates advance.

    The factor only ever accumulates *future* corporate actions, so walking
    forward in time it can only rise toward 1.0. A material drop means the
    rows on either side were adjusted on different bases — the exact fingerprint
    of a partially re-fetched history.

    Restricted to the target universe: a full-table window scan over 36M rows
    is not something to run daily.
    """
    uni = ctx.target_ids
    if not uni:
        return Finding("corrupt.adj_factor_monotone", "corruption",
                       "Adjustment factors increase monotonically", Status.SKIP,
                       f"{ctx.scope_label} resolved to 0 stocks")
    tol = ctx.t.adj_factor_monotone_tolerance
    rows = ctx.query_dicts("""
        WITH f AS (
            SELECT p.stock_id, p.date, p.adj_close / p.close AS factor
              FROM price_data p
             WHERE p.stock_id = ANY(%s) AND p.date >= %s
               AND p.close > 0 AND p.adj_close IS NOT NULL
        ),
        d AS (
            SELECT f.*, LAG(factor) OVER (PARTITION BY stock_id ORDER BY date) AS prev_factor,
                        LAG(date)   OVER (PARTITION BY stock_id ORDER BY date) AS prev_date
              FROM f
        )
        SELECT s.ticker, d.date, d.prev_date,
               round(d.prev_factor::numeric, 5) AS prev_factor,
               round(d.factor::numeric, 5) AS factor,
               round(((d.factor - d.prev_factor) * 100)::numeric, 3) AS drop_pct
          FROM d JOIN stocks s ON s.id = d.stock_id
         WHERE d.prev_factor IS NOT NULL
           AND d.factor < d.prev_factor - %s
         ORDER BY (d.prev_factor - d.factor) DESC
         LIMIT 1000
    """, (uni, ctx.window_start, tol))
    if not rows:
        return None
    return Finding(
        "corrupt.adj_factor_monotone", "corruption",
        "Adjustment factors increase monotonically", Status.WARN,
        f"{len(rows)} backward step(s) in adj_close/close across "
        f"{len({r['ticker'] for r in rows})} ticker(s)",
        metrics={"count": len(rows),
                 "tickers": len({r["ticker"] for r in rows})},
        samples=rows[:ctx.sample_limit],
        remediation="Each backward step is a seam between two differently-"
                    "adjusted stretches of history. Delete and re-fetch the "
                    "affected tickers in full.",
    )


@check("corrupt.flatline", "corruption", "No frozen price series",
       min_profile="standard", heavy=True)
def check_flatline(ctx: Context):
    """N consecutive identical closes — a dead feed or a halted/delisted name.

    Uses the classic gaps-and-islands trick: subtract a dense row number from
    the ordering so runs of the same close collapse to a constant group key.
    """
    min_days = ctx.t.flatline_min_days
    uni = ctx.target_ids
    if not uni:
        return Finding("corrupt.flatline", "corruption", "No frozen price series",
                       Status.SKIP, f"{ctx.scope_label} resolved to 0 stocks")
    rows = ctx.query_dicts("""
        WITH p AS (
            SELECT stock_id, date, close,
                   ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY date) AS rn
              FROM price_data
             WHERE stock_id = ANY(%s) AND date >= %s AND close IS NOT NULL
        ),
        grp AS (
            SELECT stock_id, close, date, rn,
                   rn - ROW_NUMBER() OVER (PARTITION BY stock_id, close ORDER BY date) AS island
              FROM p
        )
        SELECT s.ticker, g.close, COUNT(*) AS days,
               MIN(g.date) AS from_date, MAX(g.date) AS to_date
          FROM grp g JOIN stocks s ON s.id = g.stock_id
         GROUP BY s.ticker, g.stock_id, g.close, g.island
        HAVING COUNT(*) >= %s
         ORDER BY COUNT(*) DESC
         LIMIT 500
    """, (uni, ctx.window_start, min_days))
    if not rows:
        return None
    return Finding(
        "corrupt.flatline", "corruption", "No frozen price series", Status.WARN,
        f"{len(rows)} run(s) of >={min_days} identical closes among active "
        f"{ctx.universe} members",
        metrics={"count": len(rows),
                 "tickers": len({r["ticker"] for r in rows})},
        samples=rows[:ctx.sample_limit],
        remediation="A frozen series reports zero volatility and zero drawdown, "
                    "so the name looks artificially safe to the optimiser and "
                    "gets over-weighted. Usually a halted or delisted ticker "
                    "still marked is_active in stock_index_members.",
    )


@check("corrupt.zero_volume", "corruption", "No prolonged zero-volume streaks",
       min_profile="deep", heavy=True)
def check_zero_volume(ctx: Context):
    uni = ctx.target_ids
    if not uni:
        return Finding("corrupt.zero_volume", "corruption",
                       "No prolonged zero-volume streaks", Status.SKIP,
                       f"{ctx.scope_label} resolved to 0 stocks")
    rows = ctx.query_dicts("""
        WITH p AS (
            SELECT stock_id, date, COALESCE(volume, 0) AS volume,
                   ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY date) AS rn
              FROM price_data
             WHERE stock_id = ANY(%s) AND date >= %s
        ),
        z AS (
            SELECT stock_id, date, rn,
                   rn - ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY date) AS island
              FROM p WHERE volume = 0
        )
        SELECT s.ticker, COUNT(*) AS days,
               MIN(z.date) AS from_date, MAX(z.date) AS to_date
          FROM z JOIN stocks s ON s.id = z.stock_id
         GROUP BY s.ticker, z.stock_id, z.island
        HAVING COUNT(*) >= %s
         ORDER BY COUNT(*) DESC LIMIT 500
    """, (uni, ctx.window_start, ctx.t.zero_volume_streak_days))
    if not rows:
        return None
    return Finding(
        "corrupt.zero_volume", "corruption", "No prolonged zero-volume streaks",
        Status.WARN,
        f"{len(rows)} zero-volume streak(s) of >={ctx.t.zero_volume_streak_days} "
        f"days among active {ctx.member_label}s",
        metrics={"count": len(rows),
                 "tickers": len({r["ticker"] for r in rows})},
        samples=rows[:ctx.sample_limit],
        remediation="Untradeable in reality. If a backtest fills orders in these "
                    "names the simulated returns are unreachable — exclude them "
                    "via a liquidity filter or mark them inactive.",
    )
