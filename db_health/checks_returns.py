"""Total-return checks — is `adj_close` carrying the information it should,
and how much does ignoring it cost?

Context. `price_data` stores both `close` (split-adjusted only) and
`adj_close` (split *and* dividend adjusted). Every consumer in the pipeline
reads `close`:

    contrarian_screener.py:342,359,403     signals
    screener_backtest{,_v2,_v3}.py         signals AND forward returns
    elite_tracker.py, update_top_stocks.py performance measurement
    screener_macro.py                      benchmark series

Nothing reads `adj_close`. It is written on every load and consumed by no
query — roughly 36M maintained values with no reader.

That split matters differently depending on what the price is used for:

* **Signals** (drawdown from 52-week high, RSI, MA200, realised vol) are
  legitimately computed on `close`. "This name is 30% off its high" is a
  statement about price, which is what an investor anchors on. Switching
  those to `adj_close` would silently redefine the drawdown factor — a
  dividend payer's adjusted high sits below its nominal high, so its measured
  drawdown would shrink. **These checks do not argue for changing that.**

* **Realised return** is a different quantity. `fwd_return()` in the
  backtests measures `close(t+n)/close(t) - 1`, which is price return and
  excludes every dividend paid in the window. For a strategy that
  deliberately selects high-yield names — Dogs of the Dow picks the ten
  highest yielders in the DJIA by construction, and beaten-down contrarian
  candidates skew high-yield — this understates the strategy's own results,
  and it understates them *most* for the names the strategy likes best.

The checks below measure that gap on the actual data rather than assuming it.
"""

from __future__ import annotations

from statistics import median

from .core import Context, Finding, Status, check, pct


@check("ret.adj_close_usable", "returns",
       "adj_close carries dividend information", min_profile="standard")
def check_adj_close_usable(ctx: Context):
    """Before measuring the gap, confirm adj_close is actually populated and
    actually differs from close — otherwise the column is decorative and the
    total-return gap below would read as zero for the wrong reason."""
    ids = ctx.target_ids
    if not ids:
        return Finding("ret.adj_close_usable", "returns",
                       "adj_close carries dividend information", Status.SKIP,
                       f"{ctx.scope_label} resolved to 0 stocks")
    row = ctx.query_dicts("""
        WITH oldest AS (
            SELECT DISTINCT ON (stock_id) stock_id, close, adj_close
              FROM price_data
             WHERE stock_id = ANY(%s) AND date >= %s
               AND close > 0 AND adj_close IS NOT NULL AND adj_close > 0
             ORDER BY stock_id, date
        )
        SELECT COUNT(*) AS n,
               COUNT(*) FILTER (WHERE abs(adj_close / close - 1) > 0.001) AS differing
          FROM oldest
    """, (ids, ctx.window_start))[0]
    n, differing = int(row["n"]), int(row["differing"])
    if not n:
        return Finding(
            "ret.adj_close_usable", "returns",
            "adj_close carries dividend information", Status.FAIL,
            "no stock in scope has a usable (close, adj_close) pair",
            remediation="adj_close is NULL or non-positive everywhere in the "
                        "window, so total return cannot be computed at all. "
                        "See valid.null_adj_close.",
        )
    ratio = differing / n
    # In a US equity universe well over half of names pay something, so a very
    # low share means the adjustment factor is not being stored properly.
    status = Status.WARN if ratio < 0.25 else Status.PASS
    return Finding(
        "ret.adj_close_usable", "returns",
        "adj_close carries dividend information", status,
        f"{differing:,}/{n:,} ({pct(ratio)}) of in-scope tickers have an "
        f"adjustment factor that differs from 1 at the start of the window",
        metrics={"with_pair": n, "differing": differing,
                 "ratio": round(ratio, 4)},
        remediation="A US equity universe should show a large majority "
                    "differing — most names have paid a distribution at some "
                    "point. A low share means adj_close is being written equal "
                    "to close, so no dividend information is stored and total "
                    "return is unrecoverable from this table.",
    )


@check("ret.total_return_gap", "returns",
       "Cost of measuring return on close instead of adj_close",
       min_profile="standard", heavy=True)
def check_total_return_gap(ctx: Context):
    """Measure price return vs total return per ticker, over the window.

    This is a *measurement*, not a defect — it is reported as INFO unless the
    gap is large enough to change how a backtest reads. It exists to answer
    "how much does this actually matter for my data?" with real numbers
    instead of a rule of thumb.
    """
    ids = ctx.target_ids
    if not ids:
        return Finding("ret.total_return_gap", "returns",
                       "Cost of measuring return on close instead of adj_close",
                       Status.SKIP, f"{ctx.scope_label} resolved to 0 stocks")

    rows = ctx.query_dicts("""
        WITH bounds AS (
            SELECT stock_id, MIN(date) AS d0, MAX(date) AS d1
              FROM price_data
             WHERE stock_id = ANY(%(ids)s) AND date >= %(since)s
               AND close > 0 AND adj_close IS NOT NULL AND adj_close > 0
             GROUP BY stock_id
        ),
        first_bar AS (
            SELECT p.stock_id, p.close AS c0, p.adj_close AS a0
              FROM price_data p
              JOIN bounds b ON b.stock_id = p.stock_id AND b.d0 = p.date
        ),
        last_bar AS (
            SELECT p.stock_id, p.close AS c1, p.adj_close AS a1
              FROM price_data p
              JOIN bounds b ON b.stock_id = p.stock_id AND b.d1 = p.date
        )
        SELECT s.ticker, b.d0, b.d1, (b.d1 - b.d0) AS span_days,
               ((l.c1 / f.c0) - 1) * 100 AS price_return,
               ((l.a1 / f.a0) - 1) * 100 AS total_return
          FROM bounds b
          JOIN first_bar f ON f.stock_id = b.stock_id
          JOIN last_bar  l ON l.stock_id = b.stock_id
          JOIN stocks    s ON s.id       = b.stock_id
         WHERE b.d1 > b.d0 AND f.c0 > 0 AND f.a0 > 0
    """, {"ids": ids, "since": ctx.window_start})

    measured = []
    for r in rows:
        span = r["span_days"]
        if not span or span < 180:
            continue                      # too short to annualise meaningfully
        gap = float(r["total_return"]) - float(r["price_return"])
        years = span / 365.25
        measured.append({
            "ticker": r["ticker"],
            "from": r["d0"], "to": r["d1"],
            "price_return_pct": round(float(r["price_return"]), 2),
            "total_return_pct": round(float(r["total_return"]), 2),
            "gap_pct": round(gap, 2),
            "gap_pct_annualised": round(gap / years, 2),
        })
    if not measured:
        return Finding(
            "ret.total_return_gap", "returns",
            "Cost of measuring return on close instead of adj_close",
            Status.SKIP,
            "no ticker in scope has a long enough (close, adj_close) span "
            "to measure — widen --window-days",
        )

    gaps = sorted(m["gap_pct_annualised"] for m in measured)
    med = median(gaps)
    p90 = gaps[int(0.90 * (len(gaps) - 1))]
    worst = sorted(measured, key=lambda m: -m["gap_pct_annualised"])

    # Reported as INFO below the bar because a dividend yield is not a defect —
    # it only becomes one once it is big enough to reorder a backtest's
    # conclusions rather than just shift its headline number.
    status = Status.INFO if med < ctx.t.total_return_gap_warn_pp else Status.WARN

    return Finding(
        "ret.total_return_gap", "returns",
        "Cost of measuring return on close instead of adj_close", status,
        f"across {len(measured):,} tickers, measuring return on close instead "
        f"of adj_close understates annualised return by a median of "
        f"{med:.2f}pp (90th percentile {p90:.2f}pp, max "
        f"{worst[0]['gap_pct_annualised']:.2f}pp)",
        metrics={"tickers_measured": len(measured),
                 "median_gap_pp_per_year": round(med, 3),
                 "p90_gap_pp_per_year": round(p90, 3),
                 "max_gap_pp_per_year": worst[0]["gap_pct_annualised"],
                 "window_start": ctx.window_start},
        samples=worst[:ctx.sample_limit],
        remediation="This is the dividend yield the backtests are throwing "
                    "away. fwd_return() in screener_backtest{,_v2,_v3}.py "
                    "reads `close`, so every forward return it books is a "
                    "price return.\n"
                    "It is not a uniform haircut: it is largest exactly where "
                    "the strategy concentrates, so high-yield candidates are "
                    "penalised relative to low-yield ones and the ranking "
                    "itself shifts, not just the headline number.\n"
                    "Fix: switch the return measurement (not the signals) to "
                    "adj_close — see pipeline/total_return.py.",
    )


@check("ret.signal_basis", "returns", "Signal and return bases are consistent",
       min_profile="standard")
def check_signal_basis(ctx: Context):
    """Guard against the over-correction.

    Once someone learns `close` understates return, the tempting fix is to
    swap every read to `adj_close`. That silently redefines the drawdown
    factor the whole screener is built on: a dividend payer's adjusted
    52-week high sits below its nominal high, so its measured drawdown
    shrinks — and shrinks most for exactly the high-yield names the strategy
    targets.

    This check reports how much the drawdown signal would move if it were
    computed on adj_close, so the decision is made with the magnitude in view
    rather than on principle.
    """
    ids = ctx.target_ids
    if not ids:
        return Finding("ret.signal_basis", "returns",
                       "Signal and return bases are consistent", Status.SKIP,
                       f"{ctx.scope_label} resolved to 0 stocks")
    rows = ctx.query_dicts("""
        WITH win AS (
            SELECT stock_id, date, close, adj_close
              FROM price_data
             WHERE stock_id = ANY(%(ids)s)
               AND date >= CURRENT_DATE - INTERVAL '365 days'
               AND close > 0 AND adj_close IS NOT NULL AND adj_close > 0
        ),
        agg AS (
            SELECT stock_id, MAX(close) AS hi_close, MAX(adj_close) AS hi_adj
              FROM win GROUP BY stock_id
        ),
        latest AS (
            SELECT DISTINCT ON (stock_id) stock_id, close AS c, adj_close AS a
              FROM win ORDER BY stock_id, date DESC
        )
        SELECT s.ticker,
               (1 - l.c / a.hi_close) * 100 AS dd_on_close,
               (1 - l.a / a.hi_adj)   * 100 AS dd_on_adj
          FROM agg a JOIN latest l ON l.stock_id = a.stock_id
          JOIN stocks s ON s.id = a.stock_id
         WHERE a.hi_close > 0 AND a.hi_adj > 0
    """, {"ids": ids})
    if not rows:
        return Finding("ret.signal_basis", "returns",
                       "Signal and return bases are consistent", Status.SKIP,
                       "no usable 1-year window")

    diffs = []
    for r in rows:
        d = float(r["dd_on_close"]) - float(r["dd_on_adj"])
        diffs.append({"ticker": r["ticker"],
                      "drawdown_on_close_pct": round(float(r["dd_on_close"]), 2),
                      "drawdown_on_adj_pct": round(float(r["dd_on_adj"]), 2),
                      "difference_pp": round(d, 2)})
    med = median(d["difference_pp"] for d in diffs)
    worst = sorted(diffs, key=lambda d: -d["difference_pp"])
    return Finding(
        "ret.signal_basis", "returns", "Signal and return bases are consistent",
        Status.INFO,
        f"switching the drawdown signal from close to adj_close would shrink "
        f"measured 52-week drawdown by a median of {med:.2f}pp "
        f"(max {worst[0]['difference_pp']:.2f}pp) across {len(diffs):,} tickers",
        metrics={"tickers": len(diffs), "median_shift_pp": round(med, 3),
                 "max_shift_pp": worst[0]["difference_pp"]},
        samples=worst[:ctx.sample_limit],
        remediation="Informational — no action implied. Keep signals on "
                    "`close` (a drawdown is a statement about price) and "
                    "measure realised return on `adj_close`. The numbers here "
                    "are what you would give up by 'fixing' the signals too: "
                    "the shift is largest for high-yield names, which is "
                    "precisely where a contrarian screen concentrates.",
    )
