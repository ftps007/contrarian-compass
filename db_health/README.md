# `stock_data` DB Health Checker

A detailed health check for the local Postgres database that backs the
contrarian screener and every backtest:

```
postgres://localhost:5432/stock_data
```

56 checks across eight categories, built around one question: **can I trust a
contrarian simulation run against this database right now?**

> **Where this belongs.** The database, its migrations and `update_stock_data.py`
> all live in `ftps007/tangency-portfolio`, not in this repo — that is the
> natural home for this tool. It is checked in here because this session was
> scoped to `contrarian-compass`. The package is self-contained: copy
> `db_health_check.py`, `db_health/` and `scripts/db_health_cron.sh` into the
> `tangency_portfolio` root and everything works unchanged (the paths in the
> remediation text already assume that layout).

---

## Why this exists

The ingest path in `update_stock_data.py` writes prices like this:

```sql
INSERT INTO price_data (...) VALUES %s
ON CONFLICT (stock_id, date) DO NOTHING
```

That single clause is the reason a health checker is worth building.

**A row, once written, is never corrected.** When Yahoo retroactively
re-adjusts a ticker's history after a split, the rows already in the table keep
their pre-split values while newly-fetched rows arrive post-split. The series
then carries a permanent, artificial one-day move — −50% for a 2:1, −90% for a
10:1 — at the split date.

Nothing errors. Nothing logs. And the failure is *adversarially* aligned with
what this system does: a contrarian screener hunts for large drawdowns, so a
fake crash doesn't get lost in the noise — it ranks near the **top** of the
buy list. The same asymmetry applies to fundamentals: a P/E of 4 from a
mis-parsed snapshot is exactly what a value screen is looking for.

Bad data here does not degrade results gracefully. It preferentially surfaces
at the top of the ranking. That is what these checks are pointed at.

---

## Install

The checker only needs `psycopg2`, which the pipeline already depends on:

```bash
pip install psycopg2-binary
```

Drop `db_health_check.py` and the `db_health/` package next to
`update_stock_data.py`. Optionally record run history for trending:

```bash
psql -d stock_data -f db_health/migrations/006_data_quality.sql
```

## Use

```bash
# daily, before the screener — catalogue checks + bounded scans, ~seconds
python db_health_check.py --profile quick

# the default: full row-level scans over the last 400 days
python db_health_check.py --universe all_us

# weekly deep pass, recorded for trending
python db_health_check.py --profile deep --persist

# only the checks that protect simulations from silent corruption
python db_health_check.py --only corruption --only coverage

# gate a rebalance
python db_health_check.py --quiet --fail-on fail || echo "do not trade this"
```

Connection defaults match `update_stock_data.py`
(`dbname=stock_data user=$USER host=localhost port=5432`); override with
`--dsn`, `--dbname/--user/--host/--port`, or `$STOCK_DB_*`.

The run opens a **read-only** session. `--persist` reconnects separately to
write, so a check can never mutate the database it is inspecting.

### Profiles

| Profile | What it adds | Use |
|---|---|---|
| `quick` | catalogue introspection, aggregate freshness, universe resolution | daily, before the screener |
| `standard` (default) | row-level scans over `--window-days` (default 400) | after each update run |
| `deep` | whole-history scans, monotonicity, bloat, unused indexes | weekly |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | nothing at or above `--fail-on` |
| 1 | worst finding is WARN (only with `--fail-on warn`) |
| 2 | at least one FAIL |
| 3 | a check raised, or the database is unreachable |
| 4 | usage error |

### Output

`--format text` (default, colourised, leads with what needs action),
`--format json` (every metric machine-readable), `--format markdown` (paste
into a PR or a weekly note). `--output FILE` writes to disk.

---

## The check catalogue

Severity is per-check and threshold-driven; `→` marks the escalation to FAIL.

### `corruption` — silent defects that distort simulations

| Check | What it catches |
|---|---|
| `corrupt.split_artifact` | One-day moves whose price ratio matches a clean split factor (1/2, 1/3, 1/10, 3/2…). Distinguishes *stale history* (close and adj_close jump together) from *uneven adjustment* (only close jumps). **→ FAIL when an affected ticker is in the target universe.** |
| `corrupt.adj_factor_stale` | `adj_close/close` must be ~1.0 on a ticker's newest bar — the factor accumulates only *future* actions, so it is 1.0 there by construction. Anything else means the series is mid-re-adjustment. |
| `corrupt.adj_factor_monotone` | The same factor must never step *backwards* over time. A backward step is a seam between two differently-adjusted stretches of history. |
| `corrupt.bad_ticks` | A session that moves ≥50% and snaps back the next day. Real prices rarely do this; feed glitches do it constantly. Inflates realised vol and can fire a phantom stop in `stop_loss_engine.py`. |
| `corrupt.extreme_returns` | Large moves that are *neither* split-shaped nor reverting. INFO by design — biotech readouts and takeovers are real. Listed so the top of the list can be eyeballed. |
| `corrupt.flatline` | N consecutive identical closes. A frozen series reports zero volatility and zero drawdown, so the optimiser reads it as unusually safe and over-weights it. |
| `corrupt.zero_volume` | Prolonged zero-volume streaks — untradeable in reality, so any backtest filling orders there produces unreachable returns. |

### `coverage` — is the panel complete enough to simulate on

| Check | What it catches |
|---|---|
| `cover.simulation_gate` | **The go/no-go.** What share of the universe is both current *and* carries ≥252 closes over the 750-day lookback. |
| `cover.panel_completeness` | Per-ticker observed vs expected sessions, judged only over each ticker's own first..last date so a mid-window IPO isn't penalised. |
| `cover.interior_gaps` | Runs of consecutive missing sessions *inside* a history. These never self-heal — the updater fetches from `MAX(date)` forward, so a hole behind the newest row stays until `--since` forces it. |
| `cover.survivorship` | Whether `index_constituent_history` can reconstruct point-in-time membership. Without it every backtest trades *today's* index members through history — textbook survivorship bias, and it overstates returns. |
| `cover.sp500_members_at` | Exercises the actual function the backtests call, at 0/1/3/5/10 years back, asserting a plausible cross-section each time. |
| `cover.stocks_without_prices` | Index members with no price rows at all — silently dropped from the ranking, not flagged. Usually a symbol mismatch (`BRK.B` vs `BRK-B`). |
| `cover.universe_resolution` | The `stocks ⋈ stock_index_members ⋈ stock_indices` join every `--source db` run starts from. |
| `cover.history_depth` | How far back the panel actually reaches, per index. |

### `freshness` — is the data as new as it should be

Ages are measured in **NYSE sessions**, computed from the holiday rules in
`nyse_calendar.py`, not in calendar days — otherwise every Monday reads as
three days late.

| Check | What it catches |
|---|---|
| `fresh.prices` / `fresh.benchmark` | Newest bar vs sessions elapsed. The benchmark is checked separately because it anchors the reference calendar. |
| `fresh.latest_day_coverage` | Share of the universe with a close on the latest session. **The classic silent failure**: the updater commits per batch, so a rate-limited run leaves some tickers current and others behind, and the screener just scores a smaller universe. |
| `fresh.stale_tickers` | Tickers lagging the market, weighted by whether they are still active index members — a stale delisted micro-cap is noise, a stale S&P 500 name breaks a rebalance. |
| `fresh.load_continuity` | Sessions with **no** rows at all. Measured against the *computed* NYSE calendar, deliberately: a day the loader skipped is missing from the benchmark too, so a benchmark-derived calendar could never see its own holes. |
| `fresh.partial_load_days` | Days present but far below the trailing-20-session median row count — a load that died halfway. Worse than a missing day, because nothing downstream can tell it apart from a genuinely quiet session. |
| `fresh.fundamentals` / `.financials` / `.catalysts` / `.memberships` | Per-table age against each one's own cadence (weekly / 45d / 21d / monthly). A future-dated row is reported as such rather than allowed to make a stale table read as fresh. |

### `validity` — per-row invariants

`valid.ohlc` (high ≥ low, and both bound open/close), `valid.price_range`
(non-positive or absurd prices — a zero close makes log-return infinite and
poisons beta and Sharpe for the whole panel), `valid.null_close`,
`valid.null_adj_close`, `valid.volume`, `valid.calendar_alignment` (weekend
rows; future-dated rows leak lookahead into every `date <= eval_date` filter).

### `fundamentals`

`fund.coverage`, `fund.snapshot_recency` (per-stock, because a partial run
leaves `MAX(snapshot_date)` looking current while most stocks are stale — this
check is the only thing that distinguishes the two), `fund.plausibility`
(range checks loose enough to catch unit slips, not to second-guess extreme
companies), `fund.empty_snapshots` (an all-NULL row *wins* the `DISTINCT ON` in
`current_fundamentals` and hides the last good snapshot), `fund.future_snapshots`.

### `indices`

`idx.member_counts` (a short index means the Wikipedia/iShares loader partly
failed and reconciliation marked real members inactive),
`idx.duplicate_members`, `idx.inactive_but_traded` (a delisted name still
marked active is a ghost the backtest can "hold" but never exit).

### `schema`

`schema.price_key` (the `ON CONFLICT (stock_id, date)` target — without it the
updater raises instead of upserting), `schema.redundant_indexes` (**catches the
July-2026 regression automatically**: six manual duplicates on `price_data` once
cost ~5 GB and slowed every write), `schema.tables`, `schema.price_columns`,
`schema.stocks_columns`, `schema.foreign_keys` (including `NOT VALID` ones,
which guard new rows but say nothing about existing ones),
`schema.orphan_rows`, `schema.duplicate_prices`, `schema.unused_indexes`,
`schema.sequences`.

### `operations`

`ops.autovacuum`, `ops.planner_stats` (stale stats on `price_data` make the
planner mis-estimate the screener's range scans and switch to a seq scan over
36M rows), `ops.table_sizes`, `ops.long_running` (an idle-in-transaction
session holds back the vacuum horizon), `ops.cache_hit_ratio`,
`ops.bloat_estimate`, `ops.server`.

---

## Tuning

Every threshold lives in `Thresholds` in `core.py` and is overridable without
editing code:

```bash
python db_health_check.py --set stale_ticker_pct_warn=0.10 \
                          --set split_return_threshold=0.30
python db_health_check.py --thresholds my_thresholds.json
```

Defaults are tuned for a daily-updated US equity DB (~11k tickers) feeding
weekly rebalances. The two worth revisiting first:

- `split_return_threshold` (0.35) — lower catches more stale splits and more
  genuine crashes with it.
- `panel_completeness_warn` (0.98) — how much of a ticker's expected history
  must be present before it counts as simulation-ready.

## Repairing what it finds

Because `ON CONFLICT DO NOTHING` never overwrites, **every repair is
delete-then-refetch**, and forgetting the second half silently deletes history.
The helper always emits both:

```bash
# what would it take? (dry-run — changes nothing)
python -m db_health.repair --scan-splits

# individual corrupt bars, keeping the rest of the series
python -m db_health.repair --scan-invalid-bars --apply

# a full re-fetch for tickers with stale split history
python -m db_health.repair --refetch AAPL,NVDA --apply
python update_stock_data.py --prices-only --since 1990-01-01
python db_health_check.py --only corruption --only coverage
```

## Scheduling

`scripts/db_health_cron.sh` wraps the two cadences and is LaunchAgent-ready:

```
# weekday mornings, after the price load
0 23 * * 1-5  /Users/ftps/tangency_portfolio/scripts/db_health_cron.sh quick
# Saturdays, before the weekly pipeline
0 9  * * 6    /Users/ftps/tangency_portfolio/scripts/db_health_cron.sh deep
```

With `--persist`, trend the score over time:

```sql
SELECT started_at::date, profile, status, score, n_warn, n_fail
  FROM data_quality_runs ORDER BY started_at DESC LIMIT 30;

-- when did this check first start failing?
SELECT started_at, status, summary
  FROM data_quality_check_history
 WHERE check_id = 'corrupt.split_artifact' LIMIT 20;
```

## Tests

The suite builds a miniature `stock_data` replica with one seeded defect per
detector, then asserts detection in **both** directions:

```bash
createdb stock_data_fixture
python -m db_health.tests.test_health_check --dbname stock_data_fixture
python -m db_health.tests.test_health_check --dbname stock_data_fixture --clean
```

- **defective fixture** → all 31 seeded defects detected
- **clean fixture** → zero findings, score 100.0

The second direction matters as much as the first. A checker that flags healthy
data stops being read, and an unread report is worse than no report.

Each defect in `build_fixture.py` is labelled with the `check_id` it should
trip, so a threshold change that silently stops catching something fails the
test rather than the next backtest.

## Layout

```
db_health_check.py              entry point
db_health/
  core.py                       result model, registry, thresholds, runner
  nyse_calendar.py              self-contained NYSE session calendar
  checks_schema.py              structure, keys, indexes
  checks_freshness.py           recency and load continuity
  checks_integrity.py           OHLC validity + split/glitch corruption
  checks_coverage.py            panel completeness, survivorship, sim gate
  checks_fundamentals.py        factor-input quality + index membership
  checks_ops.py                 Postgres health under the daily load
  report.py                     terminal / JSON / markdown renderers
  cli.py                        argument parsing, persistence, exit codes
  repair.py                     delete-then-refetch helper
  migrations/006_data_quality.sql
  tests/                        fixture + assertions
```

Adding a check is one decorated function:

```python
@check("corrupt.my_check", "corruption", "Short title", min_profile="standard")
def check_my_thing(ctx: Context):
    rows = ctx.query_dicts("SELECT ... WHERE date >= %s", (ctx.window_start,))
    if not rows:
        return None                      # runner synthesises a PASS
    return Finding(..., remediation="the exact command to fix it")
```

A check that raises is reported as an ERROR finding and rolled back — one bad
query never aborts the run.
