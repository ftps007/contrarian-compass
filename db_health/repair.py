"""Repair helper for the defects the health checker finds.

Exists because of one specific property of the ingest path:

    INSERT ... ON CONFLICT (stock_id, date) DO NOTHING

Once a bad row is in `price_data`, re-running `update_stock_data.py` will
**not** fix it — the conflicting row is skipped, silently, forever. Every
repair therefore has to DELETE first and re-fetch second, and the two halves
must not be forgotten independently. This module emits both halves together.

Dry-run by default: it prints the plan and changes nothing. Pass --apply to
execute the deletes (the re-fetch is always left to update_stock_data.py,
which is the only thing that talks to yfinance).
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta

try:
    import psycopg2
except ImportError:                                    # pragma: no cover
    psycopg2 = None

from .checks_integrity import _split_ratio_sql
from .core import Thresholds


def _connect(args):
    if psycopg2 is None:
        sys.exit("psycopg2 is required: pip install psycopg2-binary")
    if args.dsn:
        return psycopg2.connect(args.dsn)
    return psycopg2.connect(dbname=args.dbname, user=args.user,
                            host=args.host, port=args.port)


def _resolve(cur, ticker: str) -> int | None:
    cur.execute("SELECT id FROM stocks WHERE ticker = %s LIMIT 1", (ticker,))
    row = cur.fetchone()
    return row[0] if row else None


def plan_refetch(cur, tickers: list[str], since: date | None):
    """Full-history (or since-date) wipe for tickers with corrupt series."""
    plan = []
    for t in tickers:
        sid = _resolve(cur, t)
        if sid is None:
            plan.append({"ticker": t, "error": "not in stocks"})
            continue
        if since:
            cur.execute("SELECT COUNT(*), MIN(date), MAX(date) FROM price_data "
                        "WHERE stock_id = %s AND date >= %s", (sid, since))
        else:
            cur.execute("SELECT COUNT(*), MIN(date), MAX(date) FROM price_data "
                        "WHERE stock_id = %s", (sid,))
        n, lo, hi = cur.fetchone()
        plan.append({"ticker": t, "stock_id": sid, "rows": n,
                     "from": lo, "to": hi})
    return plan


def find_split_artifacts(cur, t: Thresholds, since: date, limit: int):
    """Same detector as corrupt.split_artifact, returning repair targets."""
    tol = t.split_ratio_tolerance
    cur.execute(f"""
        WITH w AS (
            SELECT p.stock_id, p.date, p.close,
                   LAG(p.close) OVER (PARTITION BY p.stock_id ORDER BY p.date) AS prev_close
              FROM price_data p
             WHERE p.date >= %s AND p.close IS NOT NULL AND p.close > 0
        ),
        r AS (
            SELECT w.*, close / prev_close AS ratio FROM w
             WHERE prev_close IS NOT NULL AND prev_close > 0
        )
        SELECT s.ticker, r.stock_id, r.date, round(r.ratio::numeric, 5)
          FROM r JOIN stocks s ON s.id = r.stock_id
         WHERE abs(r.ratio - 1) >= %s AND {_split_ratio_sql('r.ratio', tol)}
         ORDER BY abs(r.ratio - 1) DESC LIMIT %s
    """, (since, t.split_return_threshold, limit))
    return [{"ticker": r[0], "stock_id": r[1], "date": r[2], "ratio": float(r[3])}
            for r in cur.fetchall()]


def find_invalid_bars(cur, t: Thresholds, since: date, limit: int):
    """Individual bars that violate OHLC invariants — delete row by row."""
    cur.execute("""
        SELECT s.ticker, p.stock_id, p.date
          FROM price_data p JOIN stocks s ON s.id = p.stock_id
         WHERE p.date >= %s
           AND (p.high < p.low
                OR (p.open IS NOT NULL AND p.close IS NOT NULL
                    AND (p.high < GREATEST(p.open, p.close)
                         OR p.low > LEAST(p.open, p.close)))
                OR p.close <= 0 OR p.open <= 0 OR p.high <= 0 OR p.low <= 0
                OR p.close IS NULL
                OR p.volume < 0
                OR EXTRACT(ISODOW FROM p.date) IN (6, 7)
                OR p.date > CURRENT_DATE)
         ORDER BY p.date DESC LIMIT %s
    """, (since, limit))
    return [{"ticker": r[0], "stock_id": r[1], "date": r[2]}
            for r in cur.fetchall()]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="db_health.repair",
        description="Generate (and optionally execute) repairs for defects "
                    "found by db_health_check. Dry-run unless --apply.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  # what would it take to repair two tickers with stale split history?
  python -m db_health.repair --refetch AAPL,NVDA

  # actually delete their history, then re-fetch
  python -m db_health.repair --refetch AAPL,NVDA --apply
  python update_stock_data.py --prices-only --since 1990-01-01

  # find split artifacts and plan a repair for every affected ticker
  python -m db_health.repair --scan-splits

  # drop individual corrupt bars (keeps the rest of the series)
  python -m db_health.repair --scan-invalid-bars --apply
""")
    p.add_argument("--dsn")
    p.add_argument("--dbname", default=os.environ.get("STOCK_DB_NAME", "stock_data"))
    p.add_argument("--user", default=os.environ.get("STOCK_DB_USER",
                                                    os.environ.get("USER", "postgres")))
    p.add_argument("--host", default=os.environ.get("STOCK_DB_HOST", "localhost"))
    p.add_argument("--port", type=int, default=int(os.environ.get("STOCK_DB_PORT", "5432")))

    p.add_argument("--refetch", metavar="TICKERS",
                   help="comma-separated tickers whose price history to wipe")
    p.add_argument("--scan-splits", action="store_true",
                   help="find split artifacts and plan a full re-fetch per ticker")
    p.add_argument("--scan-invalid-bars", action="store_true",
                   help="find and delete individual invalid bars")
    p.add_argument("--since", metavar="YYYY-MM-DD",
                   help="limit the wipe to rows on/after this date "
                        "(default: whole history, which is what a stale split "
                        "needs)")
    p.add_argument("--window-days", type=int, default=400,
                   help="lookback for the scanners (default 400)")
    p.add_argument("--limit", type=int, default=200)
    p.add_argument("--apply", action="store_true",
                   help="execute the deletes (default is dry-run)")
    args = p.parse_args(argv)

    if not (args.refetch or args.scan_splits or args.scan_invalid_bars):
        p.error("pick one of --refetch, --scan-splits, --scan-invalid-bars")

    since = date.fromisoformat(args.since) if args.since else None
    window_start = date.today() - timedelta(days=args.window_days)
    t = Thresholds()

    conn = _connect(args)
    conn.autocommit = False
    cur = conn.cursor()

    deletes: list[tuple[str, tuple]] = []
    earliest_refetch: date | None = None

    if args.scan_invalid_bars:
        bars = find_invalid_bars(cur, t, window_start, args.limit)
        print(f"\ninvalid bars: {len(bars)}")
        for b in bars[:20]:
            print(f"  {b['ticker']:<8} {b['date']}")
        if len(bars) > 20:
            print(f"  ... and {len(bars) - 20} more")
        for b in bars:
            deletes.append(("DELETE FROM price_data WHERE stock_id = %s AND date = %s",
                            (b["stock_id"], b["date"])))
            earliest_refetch = min(earliest_refetch or b["date"], b["date"])

    tickers: list[str] = []
    if args.refetch:
        tickers = [x.strip().upper() for x in args.refetch.split(",") if x.strip()]
    if args.scan_splits:
        hits = find_split_artifacts(cur, t, window_start, args.limit)
        print(f"\nsplit-shaped discontinuities: {len(hits)}")
        for h in hits[:20]:
            print(f"  {h['ticker']:<8} {h['date']}  ratio={h['ratio']}")
        if len(hits) > 20:
            print(f"  ... and {len(hits) - 20} more")
        for h in hits:
            if h["ticker"] not in tickers:
                tickers.append(h["ticker"])

    if tickers:
        plan = plan_refetch(cur, tickers, since)
        print(f"\nfull re-fetch plan ({len(plan)} ticker(s)):")
        for row in plan:
            if "error" in row:
                print(f"  {row['ticker']:<8} SKIP — {row['error']}")
                continue
            print(f"  {row['ticker']:<8} delete {row['rows']:>7,} rows "
                  f"({row['from']} → {row['to']})")
            if since:
                deletes.append(
                    ("DELETE FROM price_data WHERE stock_id = %s AND date >= %s",
                     (row["stock_id"], since)))
            else:
                deletes.append(("DELETE FROM price_data WHERE stock_id = %s",
                                (row["stock_id"],)))
            if row["from"]:
                earliest_refetch = min(earliest_refetch or row["from"], row["from"])

    if not deletes:
        print("\nnothing to repair.")
        conn.close()
        return 0

    refetch_since = since or earliest_refetch or date(1990, 1, 1)
    print(f"\n{'APPLYING' if args.apply else 'DRY RUN — would apply'} "
          f"{len(deletes)} delete statement(s)")

    if args.apply:
        total = 0
        for sql, params in deletes:
            cur.execute(sql, params)
            total += cur.rowcount
        conn.commit()
        print(f"deleted {total:,} row(s).")
    else:
        print("(re-run with --apply to execute)")

    print("\nSTEP 2 — re-fetch, or the deleted history stays deleted:")
    print(f"  python update_stock_data.py --prices-only --since {refetch_since}")
    print("\nSTEP 3 — verify:")
    print("  python db_health_check.py --only corruption --only coverage")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
