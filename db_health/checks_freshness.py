"""Freshness checks — is the data as new as it should be?

Everything here measures age in *trading* days where that's the meaningful
unit, using the calendar derived from the benchmark ticker's own price rows.
Calendar days would flag every Monday as "2 days stale".
"""

from __future__ import annotations

from . import nyse_calendar as nyse
from .core import (Context, Finding, Status, check, escalate_age,
                   escalate_ratio, pct)


@check("fresh.benchmark", "freshness", "Benchmark price series is current",
       min_profile="quick")
def check_benchmark_freshness(ctx: Context):
    """The benchmark defines the trading calendar every other check uses, so
    it is checked first and against wall-clock days, not against itself."""
    b = ctx.benchmark
    if not b:
        return Finding(
            "fresh.benchmark", "freshness", "Benchmark price series is current",
            Status.FAIL,
            "no benchmark ticker (SPY/^GSPC/QQQ/IWM/DIA) has any price history",
            remediation="Without a benchmark the checker cannot derive a "
                        "trading calendar and the screener cannot compute beta "
                        "(contrarian_screener._load_spy_returns needs 252 SPY "
                        "closes). Add SPY to stocks and run "
                        "update_stock_data.py --prices-only.",
        )
    sid, ticker = b
    last = ctx.scalar("SELECT MAX(date) FROM price_data WHERE stock_id = %s", (sid,))
    # Sessions, not calendar days — otherwise every Monday reads as 3 days late.
    sessions_behind = nyse.sessions_between(last, ctx.today)
    status = escalate_age(sessions_behind,
                          ctx.t.benchmark_max_age_trading_days,
                          ctx.t.price_max_age_trading_days_fail)
    return Finding(
        "fresh.benchmark", "freshness", "Benchmark price series is current",
        status,
        f"{ticker} last close {last} ({sessions_behind} NYSE session(s) behind "
        f"{ctx.today})",
        metrics={"benchmark": ticker, "last_date": last,
                 "sessions_behind": sessions_behind},
        remediation="Run update_stock_data.py --prices-only. If the benchmark "
                    "alone is stale, the trading calendar is short and every "
                    "other freshness number in this report is optimistic.",
    )


@check("fresh.prices", "freshness", "price_data is current", min_profile="quick")
def check_price_freshness(ctx: Context):
    last = ctx.scalar("SELECT MAX(date) FROM price_data")
    if last is None:
        return Finding("fresh.prices", "freshness", "price_data is current",
                       Status.FAIL, "price_data is empty",
                       remediation="Run update_stock_data.py --prices-only.")
    behind = nyse.sessions_between(last, ctx.today)
    status = escalate_age(behind, ctx.t.price_max_age_trading_days,
                          ctx.t.price_max_age_trading_days_fail)
    earliest = ctx.scalar("SELECT MIN(date) FROM price_data")
    return Finding(
        "fresh.prices", "freshness", "price_data is current", status,
        f"latest price row {last} ({behind} NYSE session(s) behind {ctx.today}); "
        f"spans {earliest} → {last}",
        metrics={"max_date": last, "min_date": earliest,
                 "sessions_behind": behind},
        remediation="Run update_stock_data.py --prices-only (cheap, ~1-3 min "
                    "once caught up).",
    )


@check("fresh.latest_day_coverage", "freshness",
       "Latest trading day covers the universe", min_profile="quick")
def check_latest_day_coverage(ctx: Context):
    """A partial load is the most dangerous failure mode here.

    The updater cohorts tickers and commits per batch, so an interrupted or
    rate-limited run leaves *some* tickers current and others a day behind.
    Nothing errors; the screener just silently scores a smaller universe.
    """
    cal_last = ctx.last_trading_day
    if not cal_last:
        return Finding("fresh.latest_day_coverage", "freshness",
                       "Latest trading day covers the universe",
                       Status.SKIP, "no trading calendar available")
    uni = ctx.target_ids
    if not uni:
        return Finding("fresh.latest_day_coverage", "freshness",
                       "Latest trading day covers the universe", Status.SKIP,
                       f"{ctx.scope_label} resolved to 0 stocks")
    have = int(ctx.scalar("""
        SELECT COUNT(DISTINCT stock_id) FROM price_data
         WHERE date = %s AND stock_id = ANY(%s) AND close IS NOT NULL
    """, (cal_last, uni)) or 0)
    ratio = have / len(uni)
    status = escalate_ratio(ratio, ctx.t.latest_day_coverage_warn,
                            ctx.t.latest_day_coverage_fail)
    samples = []
    if status != Status.PASS:
        samples = ctx.query_dicts("""
            SELECT s.ticker, MAX(p.date) AS last_date
              FROM stocks s
              LEFT JOIN price_data p ON p.stock_id = s.id
             WHERE s.id = ANY(%s)
               AND NOT EXISTS (SELECT 1 FROM price_data q
                                WHERE q.stock_id = s.id AND q.date = %s
                                  AND q.close IS NOT NULL)
             GROUP BY s.ticker ORDER BY s.ticker LIMIT %s
        """, (uni, cal_last, ctx.sample_limit))
    return Finding(
        "fresh.latest_day_coverage", "freshness",
        "Latest trading day covers the universe", status,
        f"{have:,}/{len(uni):,} ({pct(ratio)}) of the {ctx.scope_label} "
        f"has a close for {cal_last}",
        metrics={"date": cal_last, "covered": have, "universe_size": len(uni),
                 "coverage": round(ratio, 4)},
        samples=samples,
        remediation="Re-run update_stock_data.py --prices-only; it only fetches "
                    "from each ticker's last-known date so a re-run is cheap "
                    "and idempotent. A partial load makes the screener rank a "
                    "silently smaller universe.",
    )


@check("fresh.stale_tickers", "freshness", "Few tickers lag the market",
       min_profile="standard")
def check_stale_tickers(ctx: Context):
    """Tickers whose newest row is materially behind the last trading day.

    Some lag is normal and healthy — delistings, halts, acquisitions. The
    check is on the *proportion*, and it lists the worst offenders that are
    still active index members, because those are the ones that will distort
    a simulation.
    """
    cal_last = ctx.last_trading_day
    if not cal_last:
        return Finding("fresh.stale_tickers", "freshness",
                       "Few tickers lag the market", Status.SKIP,
                       "no trading calendar available")
    cal = ctx.calendar
    lag = ctx.t.stale_ticker_lag_days
    cutoff = cal[-min(lag + 1, len(cal))] if cal else cal_last

    cols = ctx.columns("stocks")
    where_test = " AND s.test_issue IS DISTINCT FROM 'Y'" if "test_issue" in cols else ""
    rows = ctx.query_dicts(f"""
        SELECT s.id, s.ticker, MAX(p.date) AS last_date
          FROM stocks s
          JOIN price_data p ON p.stock_id = s.id
         WHERE s.ticker IS NOT NULL AND s.ticker <> ''{where_test}
         GROUP BY s.id, s.ticker
        HAVING MAX(p.date) < %s
    """, (cutoff,))
    total = ctx.tradable_stocks_count or 1
    ratio = len(rows) / total
    status = escalate_age(ratio, ctx.t.stale_ticker_pct_warn,
                          ctx.t.stale_ticker_pct_fail)

    # Prioritise stale tickers that are *active index members* — a stale
    # delisted micro-cap is noise; a stale S&P 500 name breaks a rebalance.
    uni = set(ctx.target_ids)
    in_universe = [r for r in rows if r["id"] in uni]
    if in_universe and status == Status.PASS:
        status = Status.WARN
    ordered = sorted(in_universe or rows, key=lambda r: r["last_date"])

    return Finding(
        "fresh.stale_tickers", "freshness", "Few tickers lag the market", status,
        f"{len(rows):,}/{total:,} ({pct(ratio)}) tickers are >{lag} trading days "
        f"stale; {len(in_universe)} of them are active {ctx.member_label}s",
        metrics={"stale": len(rows), "total": total, "ratio": round(ratio, 4),
                 "stale_in_universe": len(in_universe), "cutoff": cutoff},
        samples=[{"ticker": r["ticker"], "last_date": r["last_date"],
                  "in_universe": r["id"] in uni} for r in ordered[:ctx.sample_limit]],
        remediation="Stale names that are still index members are the ones to "
                    "act on: either yfinance is failing for that symbol (check "
                    "for a ticker change) or the name was delisted and should "
                    "be marked is_active = false in stock_index_members.",
    )


def _table_age_check(ctx: Context, *, check_id: str, table: str, column: str,
                     title: str, warn_days: int, fail_days: int,
                     remediation: str):
    if not ctx.has_table(table):
        return Finding(check_id, "freshness", title, Status.SKIP,
                       f"{table} not present")
    last = ctx.scalar(f"SELECT MAX({column}) FROM {table}")
    if last is None:
        return Finding(check_id, "freshness", title, Status.WARN,
                       f"{table} is empty", remediation=remediation)
    if hasattr(last, "date"):
        last = last.date()
    age = (ctx.today - last).days
    if age < 0:
        # A future-dated row wins MAX() and would otherwise make a stale table
        # read as fresh. The dedicated future-date checks explain the cause.
        return Finding(
            check_id, "freshness", title, Status.WARN,
            f"newest {table}.{column} is {last}, which is {-age}d in the future",
            metrics={"last": last, "age_days": age},
            remediation="A future-dated row masks staleness in this check and "
                        "leaks lookahead into point-in-time queries. Delete it, "
                        "then re-read this check.",
        )
    return Finding(
        check_id, "freshness", title,
        escalate_age(age, warn_days, fail_days),
        f"newest {table}.{column} is {last} ({age}d old)",
        metrics={"last": last, "age_days": age}, remediation=remediation,
    )


@check("fresh.fundamentals", "freshness", "Fundamentals snapshots are current",
       min_profile="quick")
def check_fundamentals_freshness(ctx: Context):
    return _table_age_check(
        ctx, check_id="fresh.fundamentals", table="stock_fundamentals",
        column="snapshot_date", title="Fundamentals snapshots are current",
        warn_days=ctx.t.fundamentals_max_age_days,
        fail_days=ctx.t.fundamentals_max_age_days_fail,
        remediation="Run update_stock_data.py --fundamentals-only. Cadence is "
                    "weekly; the screener's valuation and quality factors all "
                    "read from current_fundamentals, so a stale snapshot ranks "
                    "on out-of-date P/E and ROE.",
    )


@check("fresh.financials", "freshness", "SEC financials are current",
       min_profile="quick")
def check_financials_freshness(ctx: Context):
    return _table_age_check(
        ctx, check_id="fresh.financials", table="stock_financials",
        column="fetched_at", title="SEC financials are current",
        warn_days=ctx.t.financials_max_age_days,
        fail_days=ctx.t.financials_max_age_days * 3,
        remediation="Run screener_financials_fetcher.py --top 150. These feed "
                    "the Piotroski F / Altman Z / Beneish M value-trap scores.",
    )


@check("fresh.catalysts", "freshness", "Catalyst extraction is current",
       min_profile="quick")
def check_catalysts_freshness(ctx: Context):
    return _table_age_check(
        ctx, check_id="fresh.catalysts", table="stock_catalysts",
        column="catalyst_date", title="Catalyst extraction is current",
        warn_days=ctx.t.catalysts_max_age_days,
        fail_days=ctx.t.catalysts_max_age_days * 3,
        remediation="Run update_stock_catalysts.py.",
    )


@check("fresh.memberships", "freshness", "Index memberships are current",
       min_profile="quick")
def check_membership_freshness(ctx: Context):
    if not ctx.has_table("stock_indices"):
        return Finding("fresh.memberships", "freshness",
                       "Index memberships are current", Status.SKIP,
                       "stock_indices not present")
    if "last_updated" not in ctx.columns("stock_indices"):
        return Finding("fresh.memberships", "freshness",
                       "Index memberships are current", Status.SKIP,
                       "stock_indices.last_updated not present")
    rows = ctx.query_dicts("""
        SELECT symbol, last_updated FROM stock_indices ORDER BY symbol
    """)
    stale = []
    for r in rows:
        if r["last_updated"] is None:
            stale.append({"index": r["symbol"], "last_updated": None,
                          "age_days": None})
            continue
        age = (ctx.today - r["last_updated"]).days
        if age > ctx.t.memberships_max_age_days:
            stale.append({"index": r["symbol"],
                          "last_updated": r["last_updated"], "age_days": age})
    if not stale:
        return None
    return Finding(
        "fresh.memberships", "freshness", "Index memberships are current",
        Status.WARN,
        f"{len(stale)}/{len(rows)} index(es) not refreshed in "
        f"{ctx.t.memberships_max_age_days}d",
        metrics={"stale": len(stale), "total": len(rows)},
        samples=stale[:ctx.sample_limit],
        remediation="Run update_stock_data.py --memberships-only (monthly "
                    "cadence). Stale membership means the screener ranks last "
                    "quarter's index — additions are missed and deletions are "
                    "still traded.",
    )


@check("fresh.load_continuity", "freshness", "No missing market days",
       min_profile="standard")
def check_load_continuity(ctx: Context):
    """NYSE sessions inside the window for which the table holds no rows at all.

    Deliberately measured against the *computed* NYSE calendar rather than the
    benchmark's own rows. A day the loader skipped entirely is missing from the
    benchmark too, so a benchmark-derived calendar can never see its own holes
    — the check would be structurally incapable of failing.

    Trade-off: the computed calendar models the regular holiday schedule, not
    one-off closures (hurricanes, days of mourning). Those show up here as a
    false positive roughly once every few years.
    """
    last_loaded = ctx.scalar("SELECT MAX(date) FROM price_data")
    if last_loaded is None:
        return Finding("fresh.load_continuity", "freshness",
                       "No missing market days", Status.SKIP,
                       "price_data is empty")
    # Clamp: a stray future-dated row must not make every session between now
    # and that date read as "missing". valid.calendar_alignment owns that defect.
    last_loaded = min(last_loaded, ctx.today)
    start = max(ctx.window_start,
                ctx.scalar("SELECT MIN(date) FROM price_data") or ctx.window_start)
    expected = nyse.trading_days(start, last_loaded)
    if not expected:
        return Finding("fresh.load_continuity", "freshness",
                       "No missing market days", Status.SKIP,
                       "window contains no NYSE sessions")
    have = {r[0] for r in ctx.query(
        "SELECT DISTINCT date FROM price_data WHERE date >= %s AND date <= %s",
        (start, last_loaded))}
    missing = [d for d in expected if d not in have]
    if not missing:
        return None
    return Finding(
        "fresh.load_continuity", "freshness", "No missing market days",
        Status.FAIL,
        f"{len(missing)} NYSE session(s) between {start} and {last_loaded} have "
        f"no price rows at all",
        metrics={"missing_days": len(missing), "expected_sessions": len(expected),
                 "first": missing[0], "last": missing[-1]},
        samples=[{"date": d} for d in missing[:ctx.sample_limit]],
        remediation="Backfill with update_stock_data.py --prices-only --since "
                    f"{missing[0]}. This does NOT self-heal: the updater fetches "
                    "from each ticker's MAX(date) forward, so an interior gap "
                    "stays until --since forces it. (An unscheduled market "
                    "closure would also appear here — check the date before "
                    "backfilling.)",
    )


@check("fresh.partial_load_days", "freshness", "No partially-loaded days",
       min_profile="standard")
def check_partial_load_days(ctx: Context):
    """Days present but with far fewer rows than their neighbours.

    A day at 60% of the trailing median is a load that died halfway — worse
    than a missing day, because nothing downstream can tell it apart from a
    day when most of the market genuinely had no quote.
    """
    # Postgres has no windowed percentile_cont, so the rolling median is
    # computed here rather than in SQL. The daily counts are one row per
    # session — a few hundred at most — so this is cheap.
    # Future-dated rows are their own defect (valid.calendar_alignment); left
    # in here they read as a "partial day" of one row and bury the real ones.
    daily = ctx.query("""
        SELECT date, COUNT(*) AS n FROM price_data
         WHERE date >= %s AND date <= %s GROUP BY date ORDER BY date
    """, (ctx.window_start, ctx.today))
    rows = []
    for i, (d, n) in enumerate(daily):
        window = [c for _, c in daily[max(0, i - 20):i]]
        if len(window) < 5:
            continue
        window.sort()
        mid = len(window) // 2
        median = (window[mid] if len(window) % 2
                  else (window[mid - 1] + window[mid]) / 2)
        if median > 0 and n < median * ctx.t.daily_rowcount_drop_warn:
            rows.append({"date": d, "n": n, "trailing_median": median})
    rows.sort(key=lambda r: r["date"], reverse=True)
    if not rows:
        return None
    severe = [r for r in rows
              if r["n"] < r["trailing_median"] * ctx.t.daily_rowcount_drop_fail]
    status = Status.FAIL if severe else Status.WARN
    return Finding(
        "fresh.partial_load_days", "freshness", "No partially-loaded days", status,
        f"{len(rows)} day(s) below {pct(ctx.t.daily_rowcount_drop_warn)} of the "
        f"trailing-20-day median row count ({len(severe)} severe)",
        metrics={"count": len(rows), "severe": len(severe)},
        samples=[{"date": r["date"], "rows": int(r["n"]),
                  "trailing_median": int(r["trailing_median"]),
                  "ratio": round(r["n"] / r["trailing_median"], 3)}
                 for r in rows[:ctx.sample_limit]],
        remediation="Re-run the loader for those dates with "
                    "update_stock_data.py --prices-only --since <date>. The most "
                    "recent day will look partial while the market is still open "
                    "or mid-load — check the date before acting.",
    )
