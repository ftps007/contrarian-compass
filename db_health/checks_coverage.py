"""Coverage and simulation-readiness checks.

Freshness asks "is today's data here?". Coverage asks the question that
actually decides whether a backtest is trustworthy: "for the universe and
lookback I am about to simulate, is the panel complete enough that the result
means something?"

A backtest never fails loudly on a thin panel. It quietly drops the tickers it
cannot price, and reports a return for whatever is left — which is a different,
survivorship-flavoured portfolio than the one intended.
"""

from __future__ import annotations

from datetime import timedelta

from .core import Context, Finding, Status, check, escalate_ratio, pct


@check("cover.stocks_without_prices", "coverage",
       "Tickers in stocks have price history", min_profile="standard")
def check_stocks_without_prices(ctx: Context):
    cols = ctx.columns("stocks")
    where_test = " AND s.test_issue IS DISTINCT FROM 'Y'" if "test_issue" in cols else ""
    n = int(ctx.scalar(f"""
        SELECT COUNT(*) FROM stocks s
         WHERE s.ticker IS NOT NULL AND s.ticker <> ''{where_test}
           AND NOT EXISTS (SELECT 1 FROM price_data p WHERE p.stock_id = s.id)
    """) or 0)
    total = ctx.tradable_stocks_count or 1
    if not n:
        return None
    ratio = n / total
    # Index members with no prices at all are the real problem; a random
    # untraded symbol in `stocks` is harmless.
    uni = ctx.universe_ids
    in_uni = int(ctx.scalar("""
        SELECT COUNT(*) FROM stocks s
         WHERE s.id = ANY(%s)
           AND NOT EXISTS (SELECT 1 FROM price_data p WHERE p.stock_id = s.id)
    """, (uni,)) or 0) if uni else 0
    samples = ctx.query_dicts("""
        SELECT s.ticker, s.name, s.exchange
          FROM stocks s
         WHERE s.id = ANY(%s)
           AND NOT EXISTS (SELECT 1 FROM price_data p WHERE p.stock_id = s.id)
         ORDER BY s.ticker LIMIT %s
    """, (uni, ctx.sample_limit)) if uni else []
    return Finding(
        "cover.stocks_without_prices", "coverage",
        "Tickers in stocks have price history",
        Status.FAIL if in_uni else Status.INFO,
        f"{n:,}/{total:,} ({pct(ratio)}) tickers have no price rows at all; "
        f"{in_uni} of them are active {ctx.universe} members",
        metrics={"count": n, "total": total, "in_universe": in_uni},
        samples=samples,
        remediation="An index member with zero price history is invisible to "
                    "the screener — it is silently dropped from the ranking, "
                    "not flagged. Usually a symbol yfinance names differently "
                    "(e.g. BRK.B vs BRK-B). Check the ticker mapping.",
    )


@check("cover.universe_resolution", "coverage",
       "Universe resolves to a plausible member count", min_profile="quick")
def check_universe_resolution(ctx: Context):
    syms = ctx.universe_index_symbols()
    uni = ctx.universe_stocks
    if not uni:
        return Finding(
            "cover.universe_resolution", "coverage",
            "Universe resolves to a plausible member count", Status.FAIL,
            f"universe {ctx.universe!r} (indices {', '.join(syms)}) resolved to "
            f"0 stocks",
            metrics={"universe": ctx.universe, "indices": syms},
            remediation="Every --source db screener run and every backtest "
                        "starts from this join. Run "
                        "update_stock_data.py --memberships-only.",
        )
    per_index = ctx.query_dicts("""
        SELECT i.symbol, COUNT(*) FILTER (WHERE m.is_active) AS active
          FROM stock_indices i
          LEFT JOIN stock_index_members m ON m.index_id = i.id
         WHERE i.symbol = ANY(%s)
         GROUP BY i.symbol ORDER BY i.symbol
    """, (syms,))
    return Finding(
        "cover.universe_resolution", "coverage",
        "Universe resolves to a plausible member count", Status.PASS,
        f"universe {ctx.universe!r} = {len(uni):,} distinct active members "
        f"across {', '.join(syms)}",
        metrics={"universe": ctx.universe, "members": len(uni),
                 "per_index": {r["symbol"]: r["active"] for r in per_index}},
    )


@check("cover.panel_completeness", "coverage",
       "Universe panels are complete over the sim lookback",
       min_profile="standard", heavy=True)
def check_panel_completeness(ctx: Context):
    """Per-ticker observed vs expected trading days over the backtest lookback.

    Expected days come from the benchmark calendar restricted to each ticker's
    own first..last observed date, so a name that IPO'd mid-window is judged on
    the period it could actually have traded rather than penalised for not
    existing yet.
    """
    uni = ctx.universe_ids
    if not uni:
        return Finding("cover.panel_completeness", "coverage",
                       "Universe panels are complete over the sim lookback",
                       Status.SKIP, f"universe {ctx.universe!r} resolved to 0 stocks")
    b = ctx.benchmark
    if not b:
        return Finding("cover.panel_completeness", "coverage",
                       "Universe panels are complete over the sim lookback",
                       Status.SKIP, "no benchmark to build a calendar from")
    since = ctx.today - timedelta(days=ctx.t.sim_lookback_days)
    rows = ctx.query_dicts("""
        WITH cal AS (
            SELECT date FROM price_data
             WHERE stock_id = %(bench)s AND date >= %(since)s
        ),
        span AS (
            SELECT p.stock_id, MIN(p.date) AS first_d, MAX(p.date) AS last_d,
                   COUNT(*) FILTER (WHERE p.close IS NOT NULL) AS observed
              FROM price_data p
             WHERE p.stock_id = ANY(%(uni)s) AND p.date >= %(since)s
             GROUP BY p.stock_id
        )
        SELECT s.ticker, sp.first_d, sp.last_d, sp.observed,
               (SELECT COUNT(*) FROM cal
                 WHERE cal.date BETWEEN sp.first_d AND sp.last_d) AS expected
          FROM span sp JOIN stocks s ON s.id = sp.stock_id
    """, {"bench": b[0], "since": since, "uni": uni})

    incomplete, thin = [], []
    for r in rows:
        exp = r["expected"] or 0
        obs = r["observed"] or 0
        ratio = obs / exp if exp else 1.0
        r["completeness"] = round(ratio, 4)
        r["missing_days"] = max(0, exp - obs)
        if ratio < ctx.t.panel_completeness_warn:
            incomplete.append(r)
        if obs < ctx.t.min_history_rows:
            thin.append(r)

    total = len(uni)
    with_data = len(rows)
    no_data = total - with_data
    bad = {r["ticker"] for r in incomplete} | {r["ticker"] for r in thin}
    ready = total - len(bad) - no_data
    ready_ratio = ready / total if total else 0.0

    status = escalate_ratio(ready_ratio, ctx.t.universe_ready_pct_warn,
                            ctx.t.universe_ready_pct_fail)
    worst = sorted(incomplete, key=lambda r: r["completeness"])[:ctx.sample_limit]
    return Finding(
        "cover.panel_completeness", "coverage",
        "Universe panels are complete over the sim lookback", status,
        f"{ready:,}/{total:,} ({pct(ready_ratio)}) of the {ctx.universe} universe "
        f"has a simulation-ready panel over the last {ctx.t.sim_lookback_days}d "
        f"({len(incomplete)} gappy, {len(thin)} shorter than "
        f"{ctx.t.min_history_rows} rows, {no_data} with no data)",
        metrics={"universe_size": total, "ready": ready,
                 "ready_ratio": round(ready_ratio, 4),
                 "incomplete": len(incomplete), "thin": len(thin),
                 "no_data": no_data,
                 "lookback_days": ctx.t.sim_lookback_days},
        samples=[{"ticker": r["ticker"], "observed": r["observed"],
                  "expected": r["expected"], "missing_days": r["missing_days"],
                  "completeness": r["completeness"],
                  "first": r["first_d"], "last": r["last_d"]} for r in worst],
        remediation="Tickers below the completeness bar get silently dropped "
                    "from the backtest rather than erroring, which biases the "
                    "result toward names with clean history. Backfill with "
                    "update_stock_data.py --prices-only --since <date>, or "
                    "narrow the simulation universe deliberately.",
    )


@check("cover.interior_gaps", "coverage", "No interior gaps in ticker histories",
       min_profile="standard", heavy=True)
def check_interior_gaps(ctx: Context):
    """Runs of consecutive missing trading days inside a ticker's own history.

    Distinct from panel completeness: this finds *where* the holes are. A
    contiguous 3-week hole in the middle of a series is far more damaging to a
    momentum or drawdown factor than the same number of days scattered around.

    Critically, these do not self-heal: the updater fetches from
    MAX(date)+1 forward, so any gap behind the newest row stays forever unless
    --since is used explicitly.
    """
    uni = ctx.universe_ids
    b = ctx.benchmark
    if not uni or not b:
        return Finding("cover.interior_gaps", "coverage",
                       "No interior gaps in ticker histories", Status.SKIP,
                       "no universe or benchmark available")
    since = ctx.today - timedelta(days=min(ctx.window_days, ctx.t.sim_lookback_days))
    rows = ctx.query_dicts("""
        WITH cal AS (
            SELECT date, ROW_NUMBER() OVER (ORDER BY date) AS idx
              FROM price_data WHERE stock_id = %(bench)s AND date >= %(since)s
        ),
        obs AS (
            SELECT p.stock_id, c.idx, c.date
              FROM price_data p JOIN cal c ON c.date = p.date
             WHERE p.stock_id = ANY(%(uni)s) AND p.date >= %(since)s
               AND p.close IS NOT NULL
        ),
        seq AS (
            SELECT stock_id, idx, date,
                   LAG(idx)  OVER (PARTITION BY stock_id ORDER BY idx) AS prev_idx,
                   LAG(date) OVER (PARTITION BY stock_id ORDER BY idx) AS prev_date
              FROM obs
        )
        SELECT s.ticker, seq.prev_date AS gap_start, seq.date AS gap_end,
               (seq.idx - seq.prev_idx - 1) AS missing_trading_days
          FROM seq JOIN stocks s ON s.id = seq.stock_id
         WHERE seq.prev_idx IS NOT NULL AND seq.idx - seq.prev_idx > 1
         ORDER BY (seq.idx - seq.prev_idx) DESC
         LIMIT 1000
    """, {"bench": b[0], "since": since, "uni": uni})
    if not rows:
        return None
    big = [r for r in rows if r["missing_trading_days"] >= 5]
    return Finding(
        "cover.interior_gaps", "coverage",
        "No interior gaps in ticker histories",
        Status.FAIL if big else Status.WARN,
        f"{len(rows)} interior gap(s) across "
        f"{len({r['ticker'] for r in rows})} {ctx.universe} member(s); "
        f"{len(big)} span 5+ trading days",
        metrics={"gaps": len(rows), "large_gaps": len(big),
                 "tickers": len({r["ticker"] for r in rows})},
        samples=rows[:ctx.sample_limit],
        remediation="Interior gaps never self-heal — the updater only fetches "
                    "forward from MAX(date). Backfill explicitly:\n"
                    "  python update_stock_data.py --prices-only --since <gap_start>",
    )


@check("cover.history_depth", "coverage", "Long history is available for backtests",
       min_profile="standard")
def check_history_depth(ctx: Context):
    """How far back the panel actually reaches, per index.

    STOCK_DATA.md advertises history to 1927. Worth verifying, because the
    depth of the oldest usable cross-section bounds how far any backtest can
    honestly start.
    """
    rows = ctx.query_dicts("""
        SELECT i.symbol,
               MIN(p.date) AS earliest,
               COUNT(DISTINCT p.stock_id) AS stocks_with_history
          FROM stock_indices i
          JOIN stock_index_members m ON m.index_id = i.id AND m.is_active
          JOIN price_data p ON p.stock_id = m.stock_id
         GROUP BY i.symbol ORDER BY i.symbol
    """)
    overall = ctx.scalar("SELECT MIN(date) FROM price_data")
    return Finding(
        "cover.history_depth", "coverage",
        "Long history is available for backtests", Status.INFO,
        f"price_data reaches back to {overall}",
        metrics={"earliest": overall,
                 "per_index": {r["symbol"]: str(r["earliest"]) for r in rows}},
        samples=[{"index": r["symbol"], "earliest": r["earliest"],
                  "stocks_with_history": r["stocks_with_history"]} for r in rows],
    )


@check("cover.survivorship", "coverage",
       "Point-in-time membership is reconstructable", min_profile="standard")
def check_survivorship(ctx: Context):
    """Can a backtest ask "who was in the S&P 500 on date X"?

    Without index_constituent_history, `sp500_members_at()` can only return
    *today's* members, so every historical backtest holds names that had not
    yet been added and never holds the ones that were deleted. That is textbook
    survivorship bias, and it inflates backtested returns — badly, and in the
    direction that makes a strategy look good.
    """
    if not ctx.has_table("index_constituent_history"):
        return Finding(
            "cover.survivorship", "coverage",
            "Point-in-time membership is reconstructable", Status.FAIL,
            "index_constituent_history is missing — historical membership "
            "cannot be reconstructed",
            remediation="Apply migrations/002_insider_and_history.sql and "
                        "backfill with backfill_index_history.py. Until then "
                        "every backtest carries survivorship bias: it trades "
                        "today's index members through history, which "
                        "systematically overstates returns.",
        )
    stats = ctx.query_dicts("""
        SELECT i.symbol, COUNT(*) AS events,
               MIN(h.action_date) AS earliest, MAX(h.action_date) AS latest
          FROM index_constituent_history h
          JOIN stock_indices i ON i.id = h.index_id
         GROUP BY i.symbol ORDER BY i.symbol
    """)
    if not stats:
        return Finding(
            "cover.survivorship", "coverage",
            "Point-in-time membership is reconstructable", Status.FAIL,
            "index_constituent_history exists but is empty",
            remediation="Run backfill_index_history.py (and "
                        "backfill_ndx_history.py) — an empty history table "
                        "makes sp500_members_at() return today's members for "
                        "every date, silently.",
        )
    total = sum(r["events"] for r in stats)
    # An S&P 500 with a genuine history should show ~20-25 changes a year.
    sp = next((r for r in stats if r["symbol"] == "SP500"), None)
    status = Status.PASS
    note = ""
    if sp and sp["earliest"] and sp["latest"]:
        years = max((sp["latest"] - sp["earliest"]).days / 365.25, 0.5)
        per_year = sp["events"] / years
        note = f"; SP500 averages {per_year:.1f} membership changes/yr over " \
               f"{years:.1f}y"
        if per_year < 8:
            status = Status.WARN
    return Finding(
        "cover.survivorship", "coverage",
        "Point-in-time membership is reconstructable", status,
        f"{total:,} membership events across {len(stats)} index(es){note}",
        metrics={"total_events": total,
                 "per_index": {r["symbol"]: r["events"] for r in stats}},
        samples=stats,
        remediation="Fewer changes than reality means the backfill is partial, "
                    "so point-in-time membership is only partly correct and "
                    "residual survivorship bias remains. Re-run "
                    "backfill_index_history.py.",
    )


@check("cover.sp500_members_at", "coverage",
       "sp500_members_at() returns a sane cross-section", min_profile="standard")
def check_members_at_function(ctx: Context):
    """Exercise the actual function the backtests call, at several dates."""
    exists = ctx.scalar(
        "SELECT 1 FROM pg_proc WHERE proname = 'sp500_members_at' LIMIT 1")
    if not exists:
        return Finding("cover.sp500_members_at", "coverage",
                       "sp500_members_at() returns a sane cross-section",
                       Status.SKIP, "sp500_members_at() not defined")
    lo, hi = ctx.t.index_member_bounds.get("SP500", (490, 515))
    results, bad = [], []
    for years_back in (0, 1, 3, 5, 10):
        d = ctx.today.replace(year=ctx.today.year - years_back) \
            if years_back else ctx.today
        try:
            n = int(ctx.scalar("SELECT COUNT(*) FROM sp500_members_at(%s)", (d,)) or 0)
        except Exception as exc:                       # noqa: BLE001
            ctx.conn.rollback()
            bad.append({"date": d, "error": str(exc)[:200]})
            continue
        row = {"date": d, "members": n}
        results.append(row)
        if not (lo <= n <= hi):
            bad.append({**row, "expected_range": f"{lo}-{hi}"})
    if bad:
        return Finding(
            "cover.sp500_members_at", "coverage",
            "sp500_members_at() returns a sane cross-section", Status.WARN,
            f"{len(bad)}/{len(results) + len(bad)} sampled dates return a member "
            f"count outside {lo}-{hi}",
            metrics={"samples": results}, samples=bad,
            remediation="The S&P 500 has held ~500 names throughout. A "
                        "materially different count at a past date means "
                        "index_constituent_history is incomplete for that "
                        "period, so backtests starting there are biased.",
        )
    return Finding(
        "cover.sp500_members_at", "coverage",
        "sp500_members_at() returns a sane cross-section", Status.PASS,
        "member counts are within range at every sampled date",
        metrics={"samples": results},
    )


@check("cover.simulation_gate", "coverage",
       "Simulation readiness gate", min_profile="standard", heavy=True)
def check_simulation_gate(ctx: Context):
    """The single verdict: can a contrarian backtest run right now, honestly?

    Rolls the individual coverage signals into one go/no-go, because that is
    the question actually being asked before a rebalance.
    """
    uni = ctx.universe_ids
    if not uni:
        return Finding("cover.simulation_gate", "coverage",
                       "Simulation readiness gate", Status.SKIP,
                       f"universe {ctx.universe!r} resolved to 0 stocks")
    since = ctx.today - timedelta(days=ctx.t.sim_lookback_days)
    row = ctx.query_dicts("""
        SELECT COUNT(*) AS ready FROM (
            SELECT p.stock_id
              FROM price_data p
             WHERE p.stock_id = ANY(%s) AND p.date >= %s AND p.close IS NOT NULL
             GROUP BY p.stock_id
            HAVING COUNT(*) >= %s
               AND MAX(p.date) >= %s
        ) t
    """, (uni, since, ctx.t.min_history_rows,
          ctx.calendar[-ctx.t.stale_ticker_lag_days]
          if len(ctx.calendar) > ctx.t.stale_ticker_lag_days else since))[0]
    ready = int(row["ready"])
    ratio = ready / len(uni)
    status = escalate_ratio(ratio, ctx.t.universe_ready_pct_warn,
                            ctx.t.universe_ready_pct_fail)
    return Finding(
        "cover.simulation_gate", "coverage", "Simulation readiness gate", status,
        f"{ready:,}/{len(uni):,} ({pct(ratio)}) {ctx.universe} members are both "
        f"current and carry >= {ctx.t.min_history_rows} closes over the last "
        f"{ctx.t.sim_lookback_days}d",
        metrics={"ready": ready, "universe_size": len(uni),
                 "ready_ratio": round(ratio, 4),
                 "min_history_rows": ctx.t.min_history_rows,
                 "lookback_days": ctx.t.sim_lookback_days},
        remediation="Below the fail bar, a backtest is scoring a materially "
                    "smaller universe than intended and its returns are not "
                    "comparable to previous runs. Bring prices current and "
                    "backfill gaps before rebalancing.",
    )
