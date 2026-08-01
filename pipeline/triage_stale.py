#!/usr/bin/env python3
"""Classify stale index members: did they stop trading, or did we stop fetching?

The health checker reports "43 active all_us members are >5 sessions stale"
and correctly refuses to guess what to do about them, because the two causes
need opposite treatment:

  * the company was acquired or delisted -> mark the membership inactive, or
    the screener keeps ranking a ghost and a backtest can hold a position it
    can never exit
  * the loader simply missed it (rate limit, symbol change) -> backfill it, or
    a live holding silently drops out of the universe

Guessing wrong in either direction is costly, so this asks the provider rather
than assuming. For each stale ticker it fetches a long window and compares
what comes back against what the database holds:

  LIVE      bars exist AFTER the DB's last date
            -> the DB fell behind. Backfill.
  STOPPED   bars exist, but end where the DB ends
            -> it really stopped trading. Mark inactive.
  UNKNOWN   nothing comes back at all
            -> could be a renamed symbol, could be the API. NOT auto-acted on.

That third bucket exists because a single empty response is not evidence.
BK -- Bank of New York, plainly not delisted -- returned
`YFTzMissingError('possibly delisted; no timezone found')` during this
session's repairs. Treating that as proof would have retired a live S&P 500
constituent.

    python pipeline/triage_stale.py                  # classify, change nothing
    python pipeline/triage_stale.py --apply          # retire the STOPPED ones
    python pipeline/triage_stale.py --min-days 60    # only the badly stale
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import date, timedelta

import psycopg2

STALE_SQL = """
    SELECT s.id, s.ticker, COALESCE(s.name, ''), MAX(p.date) AS last_price,
           string_agg(DISTINCT i.symbol, '|' ORDER BY i.symbol) AS indices
      FROM stocks s
      JOIN price_data p          ON p.stock_id = s.id
      JOIN stock_index_members m ON m.stock_id = s.id AND m.is_active
      JOIN stock_indices i       ON i.id = m.index_id
     WHERE i.symbol = ANY(%(indices)s)
     GROUP BY s.id, s.ticker, s.name
    HAVING MAX(p.date) < CURRENT_DATE - %(min_days)s
     ORDER BY MAX(p.date)
"""


def db_connect(args):
    if args.dsn:
        return psycopg2.connect(args.dsn)
    return psycopg2.connect(dbname=args.dbname, user=args.user,
                            host=args.host, port=args.port)


def probe(ticker: str, since: date) -> tuple[str, date | None, int]:
    """(verdict, provider's last bar date, bar count) for one ticker."""
    try:
        import yfinance as yf
        df = yf.download(ticker, start=since.isoformat(), progress=False,
                         threads=False, auto_adjust=False)
    except Exception:                                      # noqa: BLE001
        return "UNKNOWN", None, 0
    if df is None or df.empty:
        return "UNKNOWN", None, 0
    last = df.index[-1]
    return "OK", (last.date() if hasattr(last, "date") else last), len(df)


def classify(db_last: date, provider_last: date | None, bars: int,
             *, slack_days: int = 5) -> str:
    if provider_last is None or bars == 0:
        return "UNKNOWN"
    if provider_last > db_last + timedelta(days=slack_days):
        return "LIVE"
    return "STOPPED"


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--indices", default="RUA,SP500,SP400",
                   help="index symbols to consider (default RUA,SP500,SP400)")
    p.add_argument("--min-days", type=int, default=30,
                   help="only tickers whose last bar is older than this")
    p.add_argument("--apply", action="store_true",
                   help="mark STOPPED tickers inactive. LIVE and UNKNOWN are "
                        "never touched automatically.")
    p.add_argument("--pause", type=float, default=2.0)
    p.add_argument("--dsn")
    p.add_argument("--dbname", default=os.environ.get("STOCK_DB_NAME", "stock_data"))
    p.add_argument("--user", default=os.environ.get("STOCK_DB_USER",
                                                    os.environ.get("USER", "postgres")))
    p.add_argument("--host", default=os.environ.get("STOCK_DB_HOST", "localhost"))
    p.add_argument("--port", type=int, default=int(os.environ.get("STOCK_DB_PORT", "5432")))
    args = p.parse_args(argv)

    conn = db_connect(args)
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute(STALE_SQL, {"indices": [s.strip().upper()
                                        for s in args.indices.split(",")],
                            "min_days": args.min_days})
    rows = cur.fetchall()
    if not rows:
        print("no stale members — nothing to triage")
        return 0

    print(f"{'APPLYING' if args.apply else 'DRY RUN'} — {len(rows)} stale "
          f"member(s) older than {args.min_days}d\n")
    print(f"  {'ticker':<9}{'db last':>12}{'provider':>12}{'bars':>7}  "
          f"{'verdict':<9} name")
    print("  " + "-" * 74)

    buckets: dict[str, list] = {"LIVE": [], "STOPPED": [], "UNKNOWN": []}
    for sid, ticker, name, db_last, indices in rows:
        since = db_last - timedelta(days=30)
        _, provider_last, bars = probe(ticker, since)
        verdict = classify(db_last, provider_last, bars)
        buckets[verdict].append((sid, ticker, name, db_last, indices))
        print(f"  {ticker:<9}{str(db_last):>12}"
              f"{str(provider_last or '-'):>12}{bars:>7}  "
              f"{verdict:<9} {name[:30]}")
        time.sleep(args.pause)

    print(f"\n  LIVE {len(buckets['LIVE'])}   STOPPED {len(buckets['STOPPED'])}"
          f"   UNKNOWN {len(buckets['UNKNOWN'])}")

    if buckets["LIVE"]:
        print("\n  LIVE — the provider has newer bars than the DB. Backfill:")
        names = " ".join(t for _, t, *_ in buckets["LIVE"])
        print(f"    python pipeline/backfill_ticker.py {names} --from "
              f"{min(r[3] for r in buckets['LIVE'])} --apply")

    if buckets["STOPPED"]:
        print("\n  STOPPED — no bars past the DB's last date; genuinely no "
              "longer trading.")
        if args.apply:
            ids = [sid for sid, *_ in buckets["STOPPED"]]
            cur.execute("""
                UPDATE stock_index_members
                   SET is_active = false, removed_date = CURRENT_DATE
                 WHERE stock_id = ANY(%s) AND is_active
            """, (ids,))
            n = cur.rowcount
            # The membership log is what lets a point-in-time backtest
            # reconstruct this later; retiring without recording it would leave
            # the ticker looking as though it had never been a member.
            #
            # index_constituent_history and its `source` column both arrive
            # with migration 007. Retiring a ghost is worth doing even without
            # them, so adapt rather than fail — and say which happened, so a
            # silently unlogged retirement is not mistaken for a logged one.
            cur.execute("""
                SELECT to_regclass('public.index_constituent_history') IS NOT NULL,
                       EXISTS (SELECT 1 FROM information_schema.columns
                                WHERE table_name = 'index_constituent_history'
                                  AND column_name = 'source')
            """)
            have_table, have_source = cur.fetchone()
            logged = False
            if have_table:
                cols = "(index_id, ticker, action, action_date"
                vals = "m.index_id, s.ticker, 'removed', CURRENT_DATE"
                if have_source:
                    cols, vals = cols + ", source)", vals + ", 'triage'"
                else:
                    cols += ")"
                cur.execute(f"""
                    INSERT INTO index_constituent_history {cols}
                    SELECT {vals}
                      FROM stock_index_members m
                      JOIN stocks s ON s.id = m.stock_id
                     WHERE m.stock_id = ANY(%s) AND m.removed_date = CURRENT_DATE
                    ON CONFLICT DO NOTHING
                """, (ids,))
                logged = True
            conn.commit()
            print(f"    marked {n} membership(s) inactive"
                  + (", logged to history" if logged else
                     " — NOT logged: index_constituent_history missing "
                     "(apply migration 007 to make this reconstructable)"))
        else:
            print("    re-run with --apply to mark these inactive")

    if buckets["UNKNOWN"]:
        print("\n  UNKNOWN — the provider returned nothing. Could be a renamed "
              "symbol,\n  could be the API having a bad minute. Not acted on; "
              "check by hand:")
        for _, t, name, db_last, idx in buckets["UNKNOWN"]:
            print(f"    {t:<9} {str(db_last):<12} {idx:<18} {name[:28]}")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
