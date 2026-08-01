#!/usr/bin/env python3
"""Assign every ticker to at least one index, and date every change.

Complements `update_stock_data.py --memberships-only`, which handles the six
real indices (SP500/SP400/NDX/RUI/RUT/RUA) plus NYSE and IXIC. This adds the
venue, asset-class and catch-all indices that close the gap, so no ticker in
`stocks` is left unassigned — and records every add/remove into
`index_constituent_history` so membership is reconstructable at any past date.

Multi-index membership is preserved throughout: a ticker is typically in
several at once (e.g. AAPL -> SP500, NDX, RUI, RUA, IXIC, ALLUS).

Run after migration 007:

    psql -d stock_data -f pipeline/migrations/007_index_coverage.sql
    python pipeline/index_coverage.py                 # dry-run, shows the plan
    python pipeline/index_coverage.py --apply
    python pipeline/index_coverage.py --report        # coverage by index

Why the added_date matters, and where it comes from
---------------------------------------------------
Stamping every first-time membership with `today` would be a lie that is hard
to undo: it says 11,000 tickers joined their venue on the day this script
first ran, which makes `index_membership_spans` and any point-in-time query
built on it useless for all of prior history. So added_date is resolved in
priority order:

  1. an existing 'added' event in index_constituent_history (the backfill
     scripts know the real S&P/NDX dates)
  2. for venue and catch-all indices, the ticker's FIRST PRICE DATE — when it
     actually entered the dataset, which is the honest answer for a
     membership defined by "this ticker exists and trades here"
  3. today, only when neither is available

Removals are always dated the day they are observed, because that is genuinely
the only thing known: reconciliation sees that a ticker is gone, not when it
left. Those rows are marked source='reconcile' so they can be told apart from
scraped history, which carries real effective dates.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date
from typing import Iterable

import psycopg2
from psycopg2.extras import execute_values

# ── Exchange code -> venue index ──────────────────────────────────────────
# Codes are yfinance's `exchange` field as stored in stocks.exchange.
# NYQ/NMS/NGM/NCM are already handled by update_stock_data.py's NYSE/IXIC
# rules and are repeated here so a single run leaves nothing unassigned even
# if that step has not run yet.
EXCHANGE_INDEX = {
    "NYQ": "NYSE",  "NYS": "NYSE",
    "NMS": "IXIC",  "NGM": "IXIC",  "NCM": "IXIC", "NAS": "IXIC",
    "ASE": "AMEX",  "AMX": "AMEX",  "AME": "AMEX",
    "PCX": "ARCA",  "ARCA": "ARCA", "ARX": "ARCA",
    "BTS": "BATS",  "BATS": "BATS",
    "PNK": "OTC",   "OQB": "OTC",   "OQX": "OTC",
    "OTC": "OTC",   "OBB": "OTC",   "PK": "OTC",
}

# Every index this script maintains, in the order it processes them.
MANAGED = ["NYSE", "IXIC", "AMEX", "ARCA", "BATS", "OTC",
           "ETF", "TEST", "UNKNOWN", "ALLUS"]


def db_connect(args):
    if args.dsn:
        return psycopg2.connect(args.dsn)
    return psycopg2.connect(dbname=args.dbname, user=args.user,
                            host=args.host, port=args.port)


def index_ids(cur) -> dict[str, int]:
    cur.execute("SELECT symbol, id FROM stock_indices")
    return dict(cur.fetchall())


def classify(cur) -> dict[str, set[int]]:
    """Partition every ticker in `stocks` into the indices it belongs to.

    Returns {index_symbol: {stock_id, ...}}. A stock appears in several.
    """
    cur.execute("""
        SELECT id, ticker, exchange, is_etf, test_issue
          FROM stocks
         WHERE ticker IS NOT NULL AND ticker <> ''
    """)
    out: dict[str, set[int]] = {sym: set() for sym in MANAGED}

    for sid, _ticker, exchange, is_etf, test_issue in cur.fetchall():
        # Test issues are exchange plumbing, not securities. They are
        # classified rather than dropped so they stop showing up as
        # unexplained orphans, but they stay out of ALLUS so no universe
        # query can accidentally trade one.
        if test_issue == "Y":
            out["TEST"].add(sid)
            continue

        out["ALLUS"].add(sid)

        venue = EXCHANGE_INDEX.get((exchange or "").strip().upper())
        if venue:
            out[venue].add(sid)
        else:
            # Diagnostic, not a dumping ground: anything landing here is an
            # exchange code missing from EXCHANGE_INDEX, and the --report
            # output names them so the map can be extended.
            out["UNKNOWN"].add(sid)

        # Asset class is orthogonal to venue — an ETF is in both.
        if is_etf:
            out["ETF"].add(sid)

    return out


def first_price_dates(cur, stock_ids: Iterable[int]) -> dict[int, date]:
    ids = list(stock_ids)
    if not ids:
        return {}
    cur.execute("""
        SELECT stock_id, MIN(date) FROM price_data
         WHERE stock_id = ANY(%s) GROUP BY stock_id
    """, (ids,))
    return dict(cur.fetchall())


def historical_added_dates(cur, index_id: int) -> dict[str, date]:
    """Real 'added' dates already known from the backfill scripts."""
    cur.execute("""
        SELECT DISTINCT ON (ticker) ticker, action_date
          FROM index_constituent_history
         WHERE index_id = %s AND action = 'added'
         ORDER BY ticker, action_date ASC
    """, (index_id,))
    return dict(cur.fetchall())


def reconcile(cur, index_id: int, symbol: str, target: set[int],
              *, today: date, use_first_price: bool,
              apply: bool) -> dict[str, int]:
    """Bring one index's membership in line with `target`.

    Adds get a resolved added_date; removals are deactivated and dated today.
    Every transition is written to index_constituent_history. Returns counts.
    """
    # `ever_member` distinguishes a first-ever join from a re-entry, and the
    # emptiness of the index distinguishes the initial bulk population from an
    # observed change. Both matter for dating — see below.
    cur.execute("""
        SELECT stock_id, bool_or(is_active) AS active
          FROM stock_index_members WHERE index_id = %s GROUP BY stock_id
    """, (index_id,))
    rows_now = cur.fetchall()
    ever_member = {r[0] for r in rows_now}
    active_now = {r[0] for r in rows_now if r[1]}
    initial_population = not ever_member

    to_add = target - active_now
    to_remove = active_now - target
    if not (to_add or to_remove):
        return {"added": 0, "removed": 0, "active": len(active_now)}

    cur.execute("SELECT id, ticker FROM stocks WHERE id = ANY(%s)",
                (list(to_add | to_remove),))
    ticker_of = dict(cur.fetchall())

    added_events, removed_events = [], []

    if to_add:
        known = historical_added_dates(cur, index_id)
        # The first-price-date heuristic is only honest on the initial
        # population, where we are asserting membership we never observed
        # ("this ticker has been on NYSE for as long as it has existed").
        # Once the index is populated, every new member is something
        # reconciliation just *observed*, and back-dating it to the ticker's
        # first price would claim it was there all along — inventing years of
        # membership that never happened.
        use_first = use_first_price and initial_population
        firsts = first_price_dates(cur, to_add) if use_first else {}
        rows = []
        for sid in to_add:
            tkr = ticker_of.get(sid)
            if sid in ever_member:
                # Re-entry. Must open a NEW interval dated today: reusing the
                # original added_date would collide with the closed row and
                # reactivate it, erasing the removal that actually happened.
                when = today
            else:
                when = known.get(tkr) or firsts.get(sid) or today
            if when > today:
                when = today
            rows.append((sid, index_id, when, True))
            added_events.append((index_id, tkr, "added", when, "reconcile"))
        if apply:
            # DO NOTHING, never DO UPDATE: the only way to hit this conflict is
            # a same-day re-add, and silently clearing removed_date on an
            # existing row would destroy history rather than extend it.
            execute_values(cur, """
                INSERT INTO stock_index_members
                       (stock_id, index_id, added_date, is_active)
                VALUES %s
                ON CONFLICT (stock_id, index_id, added_date) DO NOTHING
            """, rows, page_size=2000)

    if to_remove:
        for sid in to_remove:
            removed_events.append(
                (index_id, ticker_of.get(sid), "removed", today, "reconcile"))
        if apply:
            cur.execute("""
                UPDATE stock_index_members
                   SET is_active = false, removed_date = %s
                 WHERE index_id = %s AND stock_id = ANY(%s) AND is_active = true
            """, (today, index_id, list(to_remove)))

    if apply and (added_events or removed_events):
        execute_values(cur, """
            INSERT INTO index_constituent_history
                   (index_id, ticker, action, action_date, source)
            VALUES %s
            ON CONFLICT (index_id, ticker, action, action_date) DO NOTHING
        """, added_events + removed_events, page_size=2000)

    return {"added": len(to_add), "removed": len(to_remove),
            "active": len(active_now) + len(to_add) - len(to_remove)}


def report(cur) -> None:
    print("\nCoverage by index")
    print("-" * 62)
    cur.execute("""
        SELECT i.symbol, i.name,
               COUNT(*) FILTER (WHERE m.is_active)     AS active,
               COUNT(*) FILTER (WHERE NOT m.is_active) AS historical,
               MIN(m.added_date) AS earliest_add
          FROM stock_indices i
          LEFT JOIN stock_index_members m ON m.index_id = i.id
         GROUP BY i.symbol, i.name ORDER BY active DESC
    """)
    for sym, name, active, hist, earliest in cur.fetchall():
        print(f"  {sym:<13} {active:>7,} active  {hist:>6,} historical   "
              f"since {earliest or '-'}   {(name or '')[:28]}")

    cur.execute("""
        SELECT COUNT(*) FROM stocks s
         WHERE s.ticker IS NOT NULL AND s.ticker <> ''
           AND s.test_issue IS DISTINCT FROM 'Y'
           AND NOT EXISTS (SELECT 1 FROM stock_index_members m
                            WHERE m.stock_id = s.id AND m.is_active)
    """)
    orphans = cur.fetchone()[0]
    print(f"\n  orphans (tradable, in no active index): {orphans:,}"
          f"{'  <-- should be 0' if orphans else '  OK'}")

    cur.execute("""
        SELECT COALESCE(s.exchange, '(null)'), COUNT(*)
          FROM stocks s
          JOIN stock_index_members m ON m.stock_id = s.id AND m.is_active
          JOIN stock_indices i ON i.id = m.index_id AND i.symbol = 'UNKNOWN'
         GROUP BY 1 ORDER BY 2 DESC LIMIT 15
    """)
    unmapped = cur.fetchall()
    if unmapped:
        print("\n  exchange codes not in EXCHANGE_INDEX (extend the map):")
        for code, n in unmapped:
            print(f"    {code:<10} {n:>6,} tickers")

    cur.execute("""
        SELECT i.symbol, COUNT(*), MIN(h.action_date), MAX(h.action_date)
          FROM index_constituent_history h
          JOIN stock_indices i ON i.id = h.index_id
         GROUP BY i.symbol ORDER BY COUNT(*) DESC
    """)
    rows = cur.fetchall()
    if rows:
        print("\nMembership history (add/remove events)")
        print("-" * 62)
        for sym, n, lo, hi in rows:
            print(f"  {sym:<13} {n:>7,} events   {lo} → {hi}")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dsn")
    p.add_argument("--dbname", default=os.environ.get("STOCK_DB_NAME", "stock_data"))
    p.add_argument("--user", default=os.environ.get("STOCK_DB_USER",
                                                    os.environ.get("USER", "postgres")))
    p.add_argument("--host", default=os.environ.get("STOCK_DB_HOST", "localhost"))
    p.add_argument("--port", type=int, default=int(os.environ.get("STOCK_DB_PORT", "5432")))
    p.add_argument("--apply", action="store_true",
                   help="write the changes (default is a dry run)")
    p.add_argument("--report", action="store_true",
                   help="print coverage and history summary, then exit")
    p.add_argument("--no-first-price-dates", action="store_true",
                   help="stamp new memberships with today instead of the "
                        "ticker's first price date")
    p.add_argument("--asof", metavar="YYYY-MM-DD",
                   help="treat this date as today")
    args = p.parse_args(argv)

    today = date.fromisoformat(args.asof) if args.asof else date.today()
    conn = db_connect(args)
    conn.autocommit = False
    cur = conn.cursor()

    if args.report:
        report(cur)
        conn.close()
        return 0

    ids = index_ids(cur)
    missing = [s for s in MANAGED if s not in ids]
    if missing:
        print(f"ERROR: indices not defined: {', '.join(missing)}", file=sys.stderr)
        print("Apply pipeline/migrations/007_index_coverage.sql first.",
              file=sys.stderr)
        conn.close()
        return 1

    buckets = classify(cur)
    print(f"{'APPLYING' if args.apply else 'DRY RUN'} — classifying "
          f"{len(buckets['ALLUS']):,} tradable tickers "
          f"(+{len(buckets['TEST']):,} test issues)\n")
    print(f"  {'index':<14}{'target':>9}{'add':>9}{'remove':>9}{'after':>9}")
    print("  " + "-" * 50)

    totals = {"added": 0, "removed": 0}
    for sym in MANAGED:
        r = reconcile(cur, ids[sym], sym, buckets[sym], today=today,
                      use_first_price=not args.no_first_price_dates,
                      apply=args.apply)
        totals["added"] += r["added"]
        totals["removed"] += r["removed"]
        print(f"  {sym:<14}{len(buckets[sym]):>9,}{r['added']:>9,}"
              f"{r['removed']:>9,}{r['active']:>9,}")

    if args.apply:
        conn.commit()
        print(f"\ncommitted: +{totals['added']:,} memberships, "
              f"-{totals['removed']:,} removals, "
              f"{totals['added'] + totals['removed']:,} history events")
        report(cur)
    else:
        conn.rollback()
        print(f"\nwould add {totals['added']:,} and remove "
              f"{totals['removed']:,} memberships")
        print("re-run with --apply to execute")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
