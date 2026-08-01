#!/usr/bin/env python3
"""Total-return price access for the screener and backtests.

The problem
-----------
`price_data` stores `close` (split-adjusted) and `adj_close` (split *and*
dividend adjusted). Every consumer reads `close`. Nothing reads `adj_close` —
it is written on every load and consumed by no query.

For **signals** that is correct and should stay. "This name is 30% off its
52-week high" is a statement about price, which is what an investor anchors
on, and recomputing it on `adj_close` would shrink measured drawdown most for
high-yield names — exactly the ones a contrarian screen is built to find.

For **realised return** it is a defect. `fwd_return()` in
screener_backtest{,_v2,_v3}.py computes

    close(t + n) / close(t) - 1

which is price return and silently drops every dividend paid in the window.
That understates the strategy's own results, and it understates them most for
the highest-yielding candidates — so it does not merely shift the headline
number, it reorders the ranking between candidates.

Run `db_health_check.py --only returns` to see the size of the gap on the
live data before deciding how much it matters.

What this module provides
-------------------------
Two functions with the basis in the name, so a future reader cannot mistake
one for the other, and a `--compare` mode that quantifies the difference on
the real database.

    from pipeline.total_return import fwd_total_return, price_series

Patching the backtests
----------------------
In screener_backtest_v3.py (and _v2, and the original), replace the body of
`fwd_return()` with a call to `fwd_total_return()`. The signature and return
type are unchanged, so no caller needs touching:

    from pipeline.total_return import fwd_total_return

    def fwd_return(conn, stock_id, start_date, days):
        return fwd_total_return(conn, stock_id, start_date, days)

Leave `fetch_at()` alone — its `SELECT date, close, volume` feeds signals.

Note on delistings: the existing docstring says a missing forward price falls
back to the last available close, "a conservative proxy". That behaviour is
preserved exactly; only the column changes.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta


# ──────────────────────────────────────────────────────────────────────────────
# Return measurement — total return, dividends included
# ──────────────────────────────────────────────────────────────────────────────

def fwd_total_return(conn, stock_id: int, start_date: date,
                     days: int) -> float | None:
    """Forward TOTAL return over `days`, in percent.

    Drop-in replacement for screener_backtest*.fwd_return(): same signature,
    same None semantics, same delisting behaviour. The only difference is that
    it reads `adj_close`, so a dividend paid inside the window is part of the
    return rather than lost.

    Falls back to `close` for any bar where `adj_close` is NULL, so a partially
    adjusted series degrades to the old behaviour for those bars instead of
    dropping the observation entirely.
    """
    cur = conn.cursor()
    cur.execute(
        "SELECT COALESCE(adj_close, close) FROM price_data "
        " WHERE stock_id = %s AND date <= %s AND COALESCE(adj_close, close) > 0 "
        " ORDER BY date DESC LIMIT 1",
        (stock_id, start_date),
    )
    p0 = cur.fetchone()
    target = start_date + timedelta(days=days)
    cur.execute(
        "SELECT COALESCE(adj_close, close), date FROM price_data "
        " WHERE stock_id = %s AND date <= %s AND COALESCE(adj_close, close) > 0 "
        " ORDER BY date DESC LIMIT 1",
        (stock_id, target),
    )
    p1 = cur.fetchone()
    if not p0 or not p1:
        return None
    p0v, p1v = float(p0[0]), float(p1[0])
    if p0v <= 0:
        return None
    # Preserved from the original: if the series stops less than halfway into
    # the window the stock probably stopped trading, so the observation is
    # dropped rather than counted as a short-horizon return.
    if (p1[1] - start_date).days < days * 0.5:
        return None
    return (p1v / p0v - 1) * 100


def fwd_price_return(conn, stock_id: int, start_date: date,
                     days: int) -> float | None:
    """Forward PRICE return — the current behaviour, kept for comparison.

    Useful when you deliberately want the price-only number (e.g. to check a
    chart) and for the --compare mode below. Not what a strategy's realised
    performance should be measured with.
    """
    cur = conn.cursor()
    cur.execute(
        "SELECT close FROM price_data WHERE stock_id = %s AND date <= %s "
        " AND close > 0 ORDER BY date DESC LIMIT 1", (stock_id, start_date))
    p0 = cur.fetchone()
    target = start_date + timedelta(days=days)
    cur.execute(
        "SELECT close, date FROM price_data WHERE stock_id = %s AND date <= %s "
        " AND close > 0 ORDER BY date DESC LIMIT 1", (stock_id, target))
    p1 = cur.fetchone()
    if not p0 or not p1:
        return None
    p0v, p1v = float(p0[0]), float(p1[0])
    if p0v <= 0 or (p1[1] - start_date).days < days * 0.5:
        return None
    return (p1v / p0v - 1) * 100


def price_series(conn, stock_id: int, start: date, end: date, *,
                 total_return: bool = False):
    """Price history for signal computation.

    `total_return` defaults to False deliberately: signals belong on `close`.
    The parameter exists so that a caller that genuinely wants a total-return
    series has to say so in the call, rather than the choice being buried in
    a SELECT list.
    """
    col = "COALESCE(adj_close, close)" if total_return else "close"
    cur = conn.cursor()
    cur.execute(
        f"SELECT date, {col}, volume FROM price_data "
        " WHERE stock_id = %s AND date BETWEEN %s AND %s "
        f"  AND {col} IS NOT NULL ORDER BY date",
        (stock_id, start, end))
    return cur.fetchall()


# ──────────────────────────────────────────────────────────────────────────────
# --compare: what does the change actually do to the backtest?
# ──────────────────────────────────────────────────────────────────────────────

def compare(conn, *, universe_symbols: list[str], horizon_days: int,
            start: date, samples: int) -> None:
    """Recompute forward returns both ways over a real universe and report.

    This is the number that decides whether the patch is worth applying: not
    the average dividend yield, but how much the *measured performance of the
    strategy* moves, and whether the ranking between candidates changes.
    """
    cur = conn.cursor()
    cur.execute("""
        SELECT DISTINCT s.id, s.ticker
          FROM stocks s
          JOIN stock_index_members m ON m.stock_id = s.id AND m.is_active
          JOIN stock_indices i       ON i.id = m.index_id
         WHERE i.symbol = ANY(%s)
         ORDER BY s.ticker
    """, (universe_symbols,))
    stocks = cur.fetchall()
    if not stocks:
        print(f"no active members for {universe_symbols}", file=sys.stderr)
        return

    rows = []
    for sid, ticker in stocks:
        pr = fwd_price_return(conn, sid, start, horizon_days)
        tr = fwd_total_return(conn, sid, start, horizon_days)
        if pr is None or tr is None:
            continue
        rows.append((ticker, pr, tr, tr - pr))
    if not rows:
        print("no ticker had prices at both ends of the window", file=sys.stderr)
        return

    rows.sort(key=lambda r: -r[3])
    gaps = sorted(r[3] for r in rows)
    n = len(rows)
    mean_pr = sum(r[1] for r in rows) / n
    mean_tr = sum(r[2] for r in rows) / n
    med_gap = gaps[n // 2]

    # Rank displacement: how far names move when scored on total return
    # instead of price return. A gap that is uniform across the universe only
    # shifts the level; a gap that reorders the ranking changes what you buy.
    by_pr = {t: i for i, (t, *_r) in enumerate(sorted(rows, key=lambda r: -r[1]))}
    by_tr = {t: i for i, (t, *_r) in enumerate(sorted(rows, key=lambda r: -r[2]))}
    moves = [abs(by_pr[t] - by_tr[t]) for t in by_pr]
    top_decile = max(1, n // 10)
    top_pr = {t for t, i in by_pr.items() if i < top_decile}
    top_tr = {t for t, i in by_tr.items() if i < top_decile}
    churn = len(top_pr ^ top_tr) / (2 * top_decile)

    print(f"\nuniverse {'+'.join(universe_symbols)} · {n:,} tickers · "
          f"{horizon_days}d forward from {start}")
    print("-" * 68)
    print(f"  mean price return          {mean_pr:8.2f}%")
    print(f"  mean total return          {mean_tr:8.2f}%")
    print(f"  mean understatement        {mean_tr - mean_pr:8.2f}pp")
    print(f"  median understatement      {med_gap:8.2f}pp")
    print(f"  90th pct understatement    {gaps[int(0.9 * (n - 1))]:8.2f}pp")
    print(f"\n  mean rank displacement     {sum(moves) / n:8.1f} places")
    print(f"  top-decile churn           {churn:8.1%}"
          "   <- names entering/leaving the top 10%")
    print(f"\n  largest understatements ({min(samples, n)} shown):")
    for t, pr, tr, gap in rows[:samples]:
        print(f"    {t:<8} price {pr:8.2f}%   total {tr:8.2f}%   +{gap:.2f}pp")
    if churn > 0.05:
        print(f"\n  Top-decile churn of {churn:.1%} means the patch changes which "
              f"names\n  the strategy selects, not just its reported return.")
    else:
        print("\n  Low churn: the gap is close to uniform here, so it mostly "
              "shifts\n  the level rather than the selection.")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description="Quantify the price-vs-total-return gap on the live DB.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  python pipeline/total_return.py --compare
  python pipeline/total_return.py --compare --universe SP500 --horizon 365
""")
    p.add_argument("--dsn")
    p.add_argument("--dbname", default=os.environ.get("STOCK_DB_NAME", "stock_data"))
    p.add_argument("--user", default=os.environ.get("STOCK_DB_USER",
                                                    os.environ.get("USER", "postgres")))
    p.add_argument("--host", default=os.environ.get("STOCK_DB_HOST", "localhost"))
    p.add_argument("--port", type=int, default=int(os.environ.get("STOCK_DB_PORT", "5432")))
    p.add_argument("--compare", action="store_true",
                   help="recompute forward returns both ways and report")
    p.add_argument("--universe", default="SP500,SP400",
                   help="comma-separated index symbols (default SP500,SP400)")
    p.add_argument("--horizon", type=int, default=365,
                   help="forward window in days (default 365)")
    p.add_argument("--start", help="YYYY-MM-DD; default: horizon+30d ago")
    p.add_argument("--samples", type=int, default=15)
    args = p.parse_args(argv)

    if not args.compare:
        p.error("nothing to do — pass --compare (this module is mainly a "
                "library; see the docstring for how to patch the backtests)")

    import psycopg2
    conn = (psycopg2.connect(args.dsn) if args.dsn else
            psycopg2.connect(dbname=args.dbname, user=args.user,
                             host=args.host, port=args.port))
    start = (date.fromisoformat(args.start) if args.start
             else date.today() - timedelta(days=args.horizon + 30))
    compare(conn,
            universe_symbols=[s.strip().upper() for s in args.universe.split(",")],
            horizon_days=args.horizon, start=start, samples=args.samples)
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
