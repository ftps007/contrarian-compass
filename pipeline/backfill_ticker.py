#!/usr/bin/env python3
"""Backfill a gap for NAMED tickers, without touching the rest of the database.

Why this exists
---------------
`update_stock_data.py --since <date>` does not do what its name suggests. The
date is a *floor* applied to every ticker, not a filter:

    cutoff_floor = since or date(2000, 1, 1)
    for stock_id, ticker, last_dt in rows:
        start = max((last_dt + timedelta(days=1)), cutoff_floor)
        if start > today: continue
        cohorts.setdefault(start, []).append(...)

Every ticker whose last bar is older than today is included, so
`--since 2026-02-09` re-fetches all ~11,000 tickers from February onward. On a
laptop that means thousands of concurrent yfinance requests, and the usual
outcome is `getaddrinfo() thread failed to start` followed by the OS killing
the process.

Worse, it would not have fixed the gap it was aimed at. A ticker with a hole
in the middle but a current last bar gets `start = MAX(date) + 1`, so the
loader fetches forward from *after* the hole and never touches it.

This script does the two things that are actually needed, for named tickers
only:

  1. DELETE the rows in the target range -- required, because the updater's
     `ON CONFLICT (stock_id, date) DO NOTHING` will never overwrite an
     existing row, so a re-fetch alone is a no-op.
  2. Re-fetch just those tickers, sequentially, and insert.

Because step 2 writes fresh rows, `adj_close` also comes back with a current
adjustment factor -- which makes this the repair path for the adj_close
seams as well.

Usage
-----
    # inspect first (default: no writes)
    python pipeline/backfill_ticker.py BNY --from 2026-02-09 --to 2026-05-13

    # do it
    python pipeline/backfill_ticker.py BNY --from 2026-02-09 --to 2026-05-13 --apply

    # several names, whole history from a date
    python pipeline/backfill_ticker.py BNY RNA MCW --from 2026-02-01 --apply

    # repair a ticker completely (splits, adjustments, everything)
    python pipeline/backfill_ticker.py GWAV --all --apply

Safety
------
A gap repair must never end with FEWER rows than it started with. That is the
invariant, and it is enforced before any DELETE runs: the fetch happens first,
and if it returns fewer rows than are already stored -- or less than
--min-fill of the range's NYSE sessions -- the ticker is left untouched.

This matters because a rate-limited Yahoo does not return an error. It returns
a *thin* frame, often a single bar, which is indistinguishable from a real
answer unless you count it. An earlier version of this script only checked for
an empty response; a one-row reply passed that test and replaced six full
series with one bar each. Hence: count, compare, retry, and refuse.

Deliberately sequential with a pause between tickers. This is a repair tool
run on a handful of names, not a bulk loader; the failure mode it replaces was
caused by too much concurrency.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import date, timedelta

import psycopg2
from psycopg2.extras import execute_values

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from db_health.nyse_calendar import trading_days as nyse_sessions  # noqa: E402


def db_connect(args):
    if args.dsn:
        return psycopg2.connect(args.dsn)
    return psycopg2.connect(dbname=args.dbname, user=args.user,
                            host=args.host, port=args.port)


def _f(x):
    try:
        v = float(x)
        return None if v != v or v in (float("inf"), float("-inf")) else v
    except (TypeError, ValueError):
        return None


def _i(x):
    v = _f(x)
    try:
        return None if v is None else int(v)
    except (TypeError, ValueError):
        return None


def resolve(cur, tickers: list[str]) -> dict[str, int]:
    cur.execute("SELECT ticker, id FROM stocks WHERE ticker = ANY(%s)", (tickers,))
    return dict(cur.fetchall())


def describe(cur, stock_id: int, lo: date, hi: date) -> dict:
    cur.execute("""
        SELECT COUNT(*), MIN(date), MAX(date),
               COUNT(*) FILTER (WHERE close IS NULL)
          FROM price_data
         WHERE stock_id = %s AND date BETWEEN %s AND %s
    """, (stock_id, lo, hi))
    n, mn, mx, nulls = cur.fetchone()
    return {"rows": n, "first": mn, "last": mx, "null_closes": nulls}


def fetch(ticker: str, lo: date, hi: date, *, attempts: int = 3,
          backoff: float = 8.0):
    """Fetch one ticker, retrying a thin response.

    Yahoo answers a rate-limited request with a near-empty frame rather than
    an error, so "few rows" and "genuinely few bars" look identical on a
    single try. Retrying separates them: throttling clears, sparse history
    does not.
    """
    best: list = []
    for attempt in range(1, attempts + 1):
        rows = _fetch_once(ticker, lo, hi)
        if len(rows) > len(best):
            best = rows
        expected = len(nyse_sessions(lo, min(hi, date.today())))
        if expected and len(best) >= expected * 0.9:
            break
        if attempt < attempts:
            time.sleep(backoff * attempt)
    return best


def _fetch_once(ticker: str, lo: date, hi: date):
    """One ticker, one request. Returns a list of insertable tuples."""
    import yfinance as yf
    df = yf.download(
        ticker,
        start=lo.isoformat(),
        end=(hi + timedelta(days=1)).isoformat(),
        auto_adjust=False,       # keep Close and Adj Close separate, as the
                                 # schema expects
        progress=False,
        threads=False,           # the whole point: no thread storm
    )
    if df is None or df.empty:
        return []
    # yfinance returns a column MultiIndex even for a single ticker in some
    # versions; flatten so .get() works either way.
    if hasattr(df.columns, "nlevels") and df.columns.nlevels > 1:
        df.columns = df.columns.get_level_values(0)
    out = []
    for d, r in df.iterrows():
        close = _f(r.get("Close"))
        if close is None:
            continue          # never write a NULL close — it would block the
                              # slot against a later, correct re-fetch
        out.append((d.date(), _f(r.get("Open")), _f(r.get("High")),
                    _f(r.get("Low")), close, _f(r.get("Adj Close")),
                    _i(r.get("Volume"))))
    return out


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("tickers", nargs="+", help="ticker symbols to repair")
    p.add_argument("--from", dest="date_from", metavar="YYYY-MM-DD",
                   help="start of the range to delete and re-fetch")
    p.add_argument("--to", dest="date_to", metavar="YYYY-MM-DD",
                   help="end of the range (default: today)")
    p.add_argument("--all", action="store_true",
                   help="repair the ticker's entire history")
    p.add_argument("--apply", action="store_true",
                   help="execute; without it nothing is written")
    p.add_argument("--pause", type=float, default=4.0,
                   help="seconds between tickers (default 4.0). Yahoo throttles "
                        "aggressively; going faster is what causes thin "
                        "responses in the first place.")
    p.add_argument("--min-fill", type=float, default=0.9,
                   help="refuse to replace a series unless the fetch returns "
                        "at least this fraction of the range's NYSE sessions "
                        "(default 0.9)")
    p.add_argument("--force", action="store_true",
                   help="override the thin-response guard. Only for symbols "
                        "that genuinely have sparse history.")
    p.add_argument("--dsn")
    p.add_argument("--dbname", default=os.environ.get("STOCK_DB_NAME", "stock_data"))
    p.add_argument("--user", default=os.environ.get("STOCK_DB_USER",
                                                    os.environ.get("USER", "postgres")))
    p.add_argument("--host", default=os.environ.get("STOCK_DB_HOST", "localhost"))
    p.add_argument("--port", type=int, default=int(os.environ.get("STOCK_DB_PORT", "5432")))
    args = p.parse_args(argv)

    if not args.all and not args.date_from:
        p.error("give --from YYYY-MM-DD, or --all for the whole history")

    lo = date(1900, 1, 1) if args.all else date.fromisoformat(args.date_from)
    hi = date.fromisoformat(args.date_to) if args.date_to else date.today()
    if hi < lo:
        p.error("--to is before --from")

    tickers = [t.strip().upper() for t in args.tickers if t.strip()]
    conn = db_connect(args)
    conn.autocommit = False
    cur = conn.cursor()

    ids = resolve(cur, tickers)
    missing = [t for t in tickers if t not in ids]
    for t in missing:
        print(f"  {t:<10} SKIP — not in stocks")
    targets = [t for t in tickers if t in ids]
    if not targets:
        conn.close()
        return 1

    print(f"\n{'APPLYING' if args.apply else 'DRY RUN'} — "
          f"{len(targets)} ticker(s), {lo} → {hi}\n")
    print(f"  {'ticker':<10}{'have now':>10}{'action':>34}")
    print("  " + "-" * 54)

    total_deleted = total_inserted = 0
    for t in targets:
        sid = ids[t]
        before = describe(cur, sid, lo, hi)
        if not args.apply:
            print(f"  {t:<10}{before['rows']:>10,}"
                  f"{'would delete + re-fetch':>34}")
            continue

        try:
            rows = fetch(t, lo, hi)
        except Exception as exc:                       # noqa: BLE001
            print(f"  {t:<10}{before['rows']:>10,}"
                  f"{'FETCH FAILED: ' + type(exc).__name__:>34}")
            print(f"             {exc}")
            continue

        # ── The guard that matters ────────────────────────────────────────
        # A gap repair must never end with FEWER rows than it started with.
        # Checking only for an empty response is not enough: a throttled or
        # rate-limited provider returns a *thin* frame — one or two bars —
        # which passes an emptiness test and then replaces a full series with
        # nothing. Compare against both what is already stored and how many
        # sessions the range actually had.
        expected = len(nyse_sessions(lo, min(hi, date.today())))
        too_thin = len(rows) < before["rows"] or (
            expected and len(rows) < expected * args.min_fill)
        if too_thin and not args.force:
            print(f"  {t:<10}{before['rows']:>10,}"
                  f"{f'REFUSED: fetch returned {len(rows)} of ~{expected}':>34}")
            print(f"             keeping the {before['rows']:,} existing rows. "
                  f"Provider is likely throttling — retry later, or --force "
                  f"if the symbol really is that sparse.")
            continue

        cur.execute("DELETE FROM price_data WHERE stock_id = %s "
                    "AND date BETWEEN %s AND %s", (sid, lo, hi))
        deleted = cur.rowcount
        execute_values(cur, """
            INSERT INTO price_data
                   (stock_id, date, open, high, low, close, adj_close, volume)
            VALUES %s
            ON CONFLICT (stock_id, date) DO NOTHING
        """, [(sid, *r) for r in rows], page_size=1000)
        inserted = cur.rowcount
        conn.commit()
        total_deleted += deleted
        total_inserted += inserted
        after = describe(cur, sid, lo, hi)
        action = f"-{deleted:,} +{inserted:,}  now {after['rows']:,}"
        print(f"  {t:<10}{before['rows']:>10,}{action:>34}")
        time.sleep(args.pause)

    if not args.apply:
        print("\n  re-run with --apply to execute")
    else:
        print(f"\n  deleted {total_deleted:,}, inserted {total_inserted:,}")
        print("\n  verify:")
        print("    python db_health_check.py --only coverage --only corruption")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
