#!/usr/bin/env python3
"""Build a miniature stock_data replica with one seeded defect per detector.

Every defect below is labelled with the check_id it is meant to trip, and
test_health_check.py asserts that exactly those checks fire. That coupling is
the point: it keeps the detectors honest, and a threshold change that silently
stops catching something fails the test rather than the next backtest.

    python -m db_health.tests.build_fixture --dbname stock_data_fixture
"""

from __future__ import annotations

import argparse
import math
import os
import random
import sys
from datetime import date, timedelta
from pathlib import Path

import psycopg2

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from db_health import nyse_calendar as nyse  # noqa: E402

FIXTURE_SQL = Path(__file__).with_name("fixture.sql")

# Clean tickers that should trip nothing — they are the control group.
CLEAN = [f"CLN{i:02d}" for i in range(1, 26)]

# ticker -> (defect description, check_ids it should trip)
DEFECTS = {
    "SPLITX":  ("close and adj_close both halve on one day — the classic "
                "ON CONFLICT DO NOTHING stale-split artifact",
                ["corrupt.split_artifact"]),
    "BADTICK": ("close spikes +90% for one session then returns",
                ["corrupt.bad_ticks"]),
    "OHLCBAD": ("one bar with high < low", ["valid.ohlc"]),
    "NEGPX":   ("one bar with close = 0", ["valid.price_range"]),
    "NULLPX":  ("one bar with a NULL close", ["valid.null_close"]),
    "NOADJ":   ("adj_close NULL across the series", ["valid.null_adj_close"]),
    "NEGVOL":  ("one bar with negative volume", ["valid.volume"]),
    "WKEND":   ("a Saturday-dated bar and a future-dated bar",
                ["valid.calendar_alignment"]),
    "GAPPY":   ("12 consecutive sessions deleted mid-history",
                ["cover.interior_gaps", "cover.panel_completeness"]),
    # A second gappy name so the aggregate completeness ratio lands clearly
    # below the warn bar rather than on top of it — a test that sits exactly
    # on a threshold passes or fails on rounding, which tests nothing.
    "GAPPY2":  ("25 consecutive sessions deleted mid-history",
                ["cover.interior_gaps", "cover.panel_completeness"]),
    "STALE":   ("no bars for the last 30 sessions",
                ["fresh.stale_tickers", "idx.inactive_but_traded"]),
    "FLAT":    ("20 consecutive identical closes", ["corrupt.flatline"]),
    "ZEROVOL": ("15 consecutive zero-volume sessions", ["corrupt.zero_volume"]),
    "ADJSTL":  ("latest bar has adj_close/close = 0.55 — the factor must be "
                "~1.0 at the newest bar, and it must never step backwards",
                ["corrupt.adj_factor_stale", "corrupt.adj_factor_monotone"]),
    "SHORTHX": ("only 40 sessions of history", ["cover.panel_completeness"]),
    "NOPRICE": ("index member with no price rows at all",
                ["cover.stocks_without_prices"]),
}

ALL_TICKERS = CLEAN + list(DEFECTS)


def _sql(cur, stmt, params=None):
    cur.execute(stmt, params)


def build(conn, *, today: date, years: int = 3, seed: int = 42,
          defects: bool = True) -> dict:
    """Build the fixture. With defects=False, produce a pristine database —
    used to prove the checker does not cry wolf on healthy data."""
    rng = random.Random(seed)
    cur = conn.cursor()
    tickers_to_build = ALL_TICKERS if defects else CLEAN

    cur.execute(FIXTURE_SQL.read_text())
    if defects:
        # DEFECT schema.redundant_indexes — (stock_id) is already served by the
        # leading column of the UNIQUE (stock_id, date) key. This is the exact
        # shape of the regression migrations/000 warns about.
        cur.execute("CREATE INDEX idx_price_stock_id ON price_data (stock_id)")
        # DEFECT fresh.memberships — NDX never refreshed.
        cur.execute("UPDATE stock_indices SET last_updated = %s "
                    "WHERE symbol = 'NDX'", (today - timedelta(days=400),))
    conn.commit()

    sessions = nyse.trading_days(today - timedelta(days=int(365.25 * years)),
                                 nyse.previous_trading_day(today + timedelta(days=1)))
    if len(sessions) < 300:
        raise SystemExit("fixture needs at least ~300 sessions of history")

    # ---- stocks + benchmark ------------------------------------------------
    sectors = ["Technology", "Healthcare", "Financials", "Energy", "Industrials"]
    ids: dict[str, int] = {}
    for i, tkr in enumerate(["SPY"] + tickers_to_build):
        cur.execute("""
            INSERT INTO stocks (ticker, name, sector, industry, market_cap,
                                exchange, test_issue, is_etf)
                 VALUES (%s, %s, %s, %s, %s, %s, NULL, %s) RETURNING id
        """, (tkr, f"{tkr} Inc", sectors[i % len(sectors)], "Widgets",
              rng.randint(1_000_000_000, 500_000_000_000),
              "NYQ" if i % 2 else "NMS", tkr == "SPY"))
        ids[tkr] = cur.fetchone()[0]

    # ---- index membership --------------------------------------------------
    cur.execute("SELECT symbol, id FROM stock_indices")
    idx = dict(cur.fetchall())
    for tkr in tickers_to_build:
        for sym in ("SP500", "RUA"):
            cur.execute("""
                INSERT INTO stock_index_members
                       (stock_id, index_id, added_date, is_active)
                     VALUES (%s, %s, %s, TRUE)
            """, (ids[tkr], idx[sym], today - timedelta(days=900)))
    if defects:
        # DEFECT idx.duplicate_members — CLN01 twice as an active SP500 member
        cur.execute("""
            INSERT INTO stock_index_members
                   (stock_id, index_id, added_date, is_active)
                 VALUES (%s, %s, %s, TRUE)
        """, (ids["CLN01"], idx["SP500"], today - timedelta(days=800)))

    # Membership history — enough events that cover.survivorship passes.
    for n in range(60):
        cur.execute("""
            INSERT INTO index_constituent_history
                   (index_id, ticker, action, action_date)
                 VALUES (%s, %s, %s, %s)
        """, (idx["SP500"], f"HIST{n:02d}", "added" if n % 2 else "removed",
              today - timedelta(days=rng.randint(30, 1000))))

    # ---- prices ------------------------------------------------------------
    rows: list[tuple] = []

    # Sentinel so `adj=None` can mean "write a real NULL" rather than
    # "default to close" — the NOADJ defect depends on the difference.
    MIRROR = object()

    def emit(tkr: str, d: date, close: float, *, adj=MIRROR,
             volume: int | None = None, high=None, low=None, open_=None):
        o = open_ if open_ is not None else close * rng.uniform(0.99, 1.01)
        h = high if high is not None else max(o, close) * rng.uniform(1.0, 1.02)
        lo = low if low is not None else min(o, close) * rng.uniform(0.98, 1.0)
        rows.append((ids[tkr], d, o, h, lo, close,
                     close if adj is MIRROR else adj,
                     rng.randint(500_000, 20_000_000) if volume is None else volume))

    def walk(tkr: str, start_px: float, days: list[date]) -> list[float]:
        px, out = start_px, []
        for _ in days:
            px *= math.exp(rng.gauss(0.0003, 0.015))
            out.append(round(px, 4))
        return out

    # Benchmark — always clean, defines the reference calendar.
    for d, px in zip(sessions, walk("SPY", 400.0, sessions)):
        emit("SPY", d, px)

    for tkr in tickers_to_build:
        if tkr == "NOPRICE":
            continue                                   # DEFECT: no rows at all

        days = list(sessions)
        if tkr == "SHORTHX":
            days = days[-40:]                          # DEFECT: thin panel
        if tkr == "STALE":
            days = days[:-30]                          # DEFECT: 30 sessions stale
        if tkr == "GAPPY":
            cut = len(days) // 2
            days = days[:cut] + days[cut + 12:]        # DEFECT: interior gap
        if tkr == "GAPPY2":
            cut = len(days) // 3
            days = days[:cut] + days[cut + 25:]        # DEFECT: bigger gap

        px = walk(tkr, rng.uniform(20, 300), days)

        for i, (d, p) in enumerate(zip(days, px)):
            adj: object = p
            vol = None
            hi = lo = op = None

            if tkr == "SPLITX" and i >= len(days) - 40:
                # DEFECT corrupt.split_artifact: history before the "split" was
                # never re-adjusted, so close AND adj_close step down together
                # by exactly 1/2 on one day and stay there.
                p, adj = round(p / 2, 4), round(p / 2, 4)
            if tkr == "BADTICK" and i == len(days) - 25:
                p = adj = round(p * 1.9, 4)            # DEFECT: spike, reverts
            if tkr == "OHLCBAD" and i == len(days) - 15:
                hi, lo = p * 0.9, p * 1.1              # DEFECT: high < low
            if tkr == "NEGPX" and i == len(days) - 12:
                p = adj = 0.0                          # DEFECT: zero close
            if tkr == "NOADJ":
                adj = None                             # DEFECT: no adj_close
            if tkr == "NEGVOL" and i == len(days) - 9:
                vol = -1                               # DEFECT: negative volume
            if tkr == "FLAT" and len(days) - 30 <= i < len(days) - 10:
                p = adj = 123.45                       # DEFECT: 20 flat closes
            if tkr == "ZEROVOL" and len(days) - 25 <= i < len(days) - 10:
                vol = 0                                # DEFECT: zero-volume run
            if tkr == "ADJSTL" and i == len(days) - 1:
                adj = round(p * 0.55, 4)               # DEFECT: stale adj factor

            emit(tkr, d, p, adj=adj, volume=vol, high=hi, low=lo, open_=op)

        if tkr == "NULLPX":
            # DEFECT valid.null_close — emitted separately so the NULL survives
            rows.append((ids[tkr], days[-7], 10.0, 10.5, 9.5, None, 10.0, 100))
            rows[:] = [r for r in rows
                       if not (r[0] == ids[tkr] and r[1] == days[-7] and r[5] is not None)]

        if tkr == "WKEND":
            sat = days[-5] + timedelta(days=(5 - days[-5].weekday()) % 7 or 7)
            emit(tkr, sat, 50.0)                       # DEFECT: weekend bar
            emit(tkr, today + timedelta(days=3), 51.0)  # DEFECT: future bar

    cur.executemany("""
        INSERT INTO price_data (stock_id, date, open, high, low, close,
                                adj_close, volume)
             VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (stock_id, date) DO NOTHING
    """, rows)

    skipped = partial = None
    if defects:
        # DEFECT fresh.load_continuity — wipe one whole session, all tickers.
        skipped = sessions[-45]
        cur.execute("DELETE FROM price_data WHERE date = %s", (skipped,))

        # DEFECT fresh.partial_load_days — keep the benchmark plus 3 names.
        partial = sessions[-20]
        cur.execute("""
            DELETE FROM price_data
             WHERE date = %s AND stock_id NOT IN (
                   SELECT id FROM stocks
                    WHERE ticker IN ('SPY','CLN01','CLN02','CLN03'))
        """, (partial,))

    # ---- fundamentals ------------------------------------------------------
    snap = nyse.previous_trading_day(today)
    # DEFECT fund.coverage — 12 of 40 members get no snapshot at all (70%
    # coverage), which is below the 80% warn threshold. Sized deliberately to
    # exercise the escalation, not just the query.
    no_fundamentals = ({"NOPRICE", "SHORTHX"} |
                       {f"CLN{i:02d}" for i in range(16, 26)}) if defects else set()
    for tkr in tickers_to_build:
        if tkr in no_fundamentals:
            continue
        cur.execute("""
            INSERT INTO stock_fundamentals
                   (stock_id, snapshot_date, trailing_pe, forward_pe,
                    price_to_book, operating_margin, roe, debt_to_equity,
                    revenue_growth_yoy, short_pct_float, recommendation_mean,
                    market_cap)
                 VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (ids[tkr], snap, round(rng.uniform(5, 40), 2),
              round(rng.uniform(5, 35), 2), round(rng.uniform(0.5, 8), 2),
              round(rng.uniform(0.02, 0.35), 4), round(rng.uniform(-0.2, 0.5), 4),
              round(rng.uniform(0, 250), 2), round(rng.uniform(-0.2, 0.4), 4),
              round(rng.uniform(0, 25), 4), round(rng.uniform(1, 5), 2),
              rng.randint(10 ** 9, 10 ** 12)))

    if defects:
        # DEFECT fund.plausibility — ROE of 9999 (a ratio/percent unit slip)
        cur.execute("UPDATE stock_fundamentals SET roe = 9999 "
                    "WHERE stock_id = %s", (ids["CLN05"],))

        # DEFECT fund.empty_snapshots — all-NULL row dated *after* the good
        # one, so it wins current_fundamentals and masks real data.
        cur.execute("INSERT INTO stock_fundamentals (stock_id, snapshot_date) "
                    "VALUES (%s, %s)", (ids["CLN06"], snap + timedelta(days=1)))

        # DEFECT fund.future_snapshots
        cur.execute("INSERT INTO stock_fundamentals "
                    "(stock_id, snapshot_date, trailing_pe) VALUES (%s, %s, 12.5)",
                    (ids["CLN07"], today + timedelta(days=30)))

        # DEFECT fund.snapshot_recency — CLN08's newest snapshot is 60d old
        cur.execute("UPDATE stock_fundamentals SET snapshot_date = %s "
                    "WHERE stock_id = %s",
                    (snap - timedelta(days=60), ids["CLN08"]))

    cur.execute("INSERT INTO stock_financials (stock_id, fiscal_period, "
                "total_assets, net_income, cfo) VALUES (%s, %s, 1, 1, 1)",
                (ids["CLN01"], today - timedelta(days=200)))
    cur.execute("INSERT INTO stock_catalysts (stock_id, catalyst_date, type, "
                "direction, impact, summary) VALUES (%s, %s, 'mna', "
                "'positive', 4, 'seeded fixture event')",
                (ids["CLN01"], today - timedelta(days=5)))

    conn.commit()
    cur.execute("ANALYZE")
    conn.commit()

    return {"sessions": len(sessions), "tickers": len(tickers_to_build) + 1,
            "price_rows": len(rows), "skipped_session": skipped,
            "partial_session": partial}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dbname", default="stock_data_fixture")
    p.add_argument("--user", default=os.environ.get("USER", "postgres"))
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=5432)
    p.add_argument("--asof", help="YYYY-MM-DD; defaults to today")
    args = p.parse_args(argv)

    today = date.fromisoformat(args.asof) if args.asof else date.today()
    conn = psycopg2.connect(dbname=args.dbname, user=args.user,
                            host=args.host, port=args.port)
    info = build(conn, today=today)
    conn.close()
    print(f"fixture built in {args.dbname}: {info}")
    print(f"seeded defects: {len(DEFECTS)} tickers + 6 table-level")
    return 0


if __name__ == "__main__":
    sys.exit(main())
