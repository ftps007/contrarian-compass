#!/usr/bin/env python3
"""Assert that the checker detects every seeded defect — and only those.

Builds the fixture from scratch, runs the full check suite against it, and
compares the set of non-passing checks to the set the fixture claims to have
seeded. Both directions matter:

  * a seeded defect that goes undetected is a hole in the checker
  * a check that fires on the clean control group is a false positive, which
    is just as damaging — a report that cries wolf stops being read

Run:  python -m db_health.tests.test_health_check --dbname stock_data_fixture
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date
from pathlib import Path

import psycopg2

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from db_health.core import Context, Status, Thresholds, run_checks  # noqa: E402
from db_health.tests.build_fixture import DEFECTS, build           # noqa: E402
import db_health.cli  # noqa: F401,E402  (imports register every check)

# Checks the fixture is built to trip. Table-level defects are listed here;
# per-ticker ones come from DEFECTS in build_fixture.
EXPECTED_TABLE_LEVEL = {
    "schema.redundant_indexes",   # idx_price_stock_id duplicates the key prefix
    "fresh.memberships",          # NDX last_updated 400 days ago
    "fresh.load_continuity",      # one session wiped for every ticker
    "fresh.partial_load_days",    # one session kept for only 4 tickers
    "idx.duplicate_members",      # CLN01 twice in SP500
    "fund.coverage",              # NOPRICE/SHORTHX have no fundamentals
    "fund.plausibility",          # CLN05 roe = 9999
    "fund.empty_snapshots",       # CLN06 all-NULL newest snapshot
    "fund.future_snapshots",      # CLN07 snapshot 30 days out
    # ...which also makes MAX(snapshot_date) future-dated, so the freshness
    # check refuses to report the table as fresh. Intended: a future row must
    # never let a stale table read as current.
    "fresh.fundamentals",
    "fund.snapshot_recency",      # CLN08 snapshot 60 days stale
    "cover.simulation_gate",      # the defective names drag readiness down
    "idx.member_counts",          # fixture has ~40 SP500 members, not ~500
    "cover.sp500_members_at",     # same reason
    # Database-wide, full-history census: the seeded defects push the share of
    # non-OK tickers past the tolerated mix, and GAPPY's 12-session hole is a
    # large gap by the absolute rule.
    "inv.census",
    "inv.full_history_gaps",
}

# Checks that legitimately report a non-PASS status on any fixture and are not
# defects: informational output, or environment facts.
IGNORE = {
    "ops.server", "ops.table_sizes", "ops.cache_hit_ratio",
    "ops.bloat_estimate", "ops.autovacuum", "ops.planner_stats",
    "ops.long_running", "ops.unused_indexes", "schema.unused_indexes",
    "cover.history_depth", "cover.stocks_without_prices",
    "corrupt.extreme_returns",   # INFO by design
    "schema.tables",             # optional objects may be absent
    "fresh.financials", "fresh.catalysts",
    "cover.survivorship",
    "inv.orphan_tickers",        # INFO/WARN on fixture size, not a defect
    # The returns checks are measurements, not defect detectors: they report
    # the size of the price-vs-total-return gap, which is a property of the
    # data (dividends exist) rather than something wrong with it.
    "ret.total_return_gap", "ret.signal_basis", "ret.adj_close_usable",
}


def expected_check_ids() -> set[str]:
    out = set(EXPECTED_TABLE_LEVEL)
    for _desc, ids in DEFECTS.values():
        out.update(ids)
    return out


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dbname", default="stock_data_fixture")
    p.add_argument("--user", default=os.environ.get("USER", "postgres"))
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=5432)
    p.add_argument("--keep", action="store_true",
                   help="do not rebuild the fixture, test what is there")
    p.add_argument("--full-history", action="store_true",
                   help="audit every ticker over its entire history "
                        "(--scope all --window-days 0)")
    p.add_argument("--clean", action="store_true",
                   help="build a defect-free fixture and assert the checker "
                        "reports nothing — the false-positive test")
    args = p.parse_args(argv)

    today = date.today()
    conn = psycopg2.connect(dbname=args.dbname, user=args.user,
                            host=args.host, port=args.port)
    if not args.keep:
        info = build(conn, today=today, defects=not args.clean)
        print(f"fixture: {info}\n")

    thresholds = Thresholds()
    if args.clean:
        # The fixture holds 25 names, not 500 — relax only the index-size
        # bounds, so every data-quality threshold stays at its real value.
        thresholds.index_member_bounds = {"SP500": (1, 10_000)}

    ctx = Context(conn, thresholds,
                  window_days=0 if args.full_history else 400,
                  universe="all_us", sample_limit=5, profile="deep",
                  scope="all" if args.full_history else "universe",
                  today=today)
    result = run_checks(ctx)

    fired = {f.check_id for f in result.findings
             if f.status in (Status.WARN, Status.FAIL, Status.ERROR)}
    errored = {f.check_id: f.summary for f in result.findings
               if f.status == Status.ERROR}
    expected = set() if args.clean else expected_check_ids()

    missed = expected - fired
    unexpected = fired - expected - IGNORE

    print(f"{'check':<36} {'status':<7} summary")
    print("-" * 100)
    for f in sorted(result.findings, key=lambda f: (f.category, f.check_id)):
        print(f"{f.check_id:<36} {f.status.label:<7} {f.summary[:56]}")

    print()
    ok = True
    if errored:
        ok = False
        print(f"FAIL — {len(errored)} check(s) raised:")
        for cid, msg in sorted(errored.items()):
            print(f"   {cid}: {msg}")
    if missed:
        ok = False
        print(f"FAIL — {len(missed)} seeded defect(s) NOT detected:")
        for cid in sorted(missed):
            print(f"   {cid}")
    if unexpected:
        ok = False
        print(f"FAIL — {len(unexpected)} unexpected finding(s) "
              f"(false positives on clean data?):")
        for cid in sorted(unexpected):
            f = next(x for x in result.findings if x.check_id == cid)
            print(f"   {cid}: {f.summary}")

    detected = len(expected & fired)
    print(f"\nscope={ctx.scope} window={ctx.window_label}")
    print(f"detected {detected}/{len(expected)} seeded defects; "
          f"{len(result.findings)} checks ran in "
          f"{result.duration_ms / 1000:.1f}s; score {result.score()}")
    print("PASS" if ok else "FAILED")
    conn.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
