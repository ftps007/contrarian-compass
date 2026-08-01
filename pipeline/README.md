# Pipeline fixes for `stock_data`

Three changes to the data layer behind the contrarian screener, each answering
a question raised by the health checker.

> **Where this belongs.** `update_stock_data.py` and the `migrations/` series
> live in `ftps007/tangency-portfolio`. These files are written to drop into
> that repo root — the paths in every command below assume it. They are here
> because this session is scoped to `contrarian-compass`.

| | What | Files |
|---|---|---|
| 1 | Measure realised return on `adj_close`, not `close` | `total_return.py` |
| 2 | Assign every ticker to at least one index | `index_coverage.py`, `migrations/007` |
| 3 | Date every membership add/remove | `index_coverage.py`, `migrations/007` |

Apply the migration first — it is idempotent and safe to re-run:

```bash
psql -d stock_data -f pipeline/migrations/007_index_coverage.sql
```

---

## 1. `close` vs `adj_close`

`price_data` stores both. **Every consumer reads `close`; nothing reads
`adj_close`** — it is written on every load and used by no query.

Whether that is a bug depends entirely on what the price is for:

**Signals — `close` is correct, leave it.** "This name is 30% off its 52-week
high" is a statement about price, which is what an investor anchors on.
Recomputing drawdown on `adj_close` would *shrink* it, because a dividend
payer's adjusted high sits below its nominal high — and shrink it most for
high-yield names, precisely the ones a contrarian screen exists to find. The
over-correction is worse than the original problem.

**Realised return — `close` is wrong.** `fwd_return()` in
`screener_backtest{,_v2,_v3}.py` computes `close(t+n)/close(t) - 1`, which
drops every dividend paid in the window. That understates the strategy's own
results, and it understates them most for the highest-yielding candidates —
so it does not merely lower the headline number, it can reorder the ranking.

Measure it on the real data before deciding:

```bash
python db_health_check.py --only returns          # gap across the universe
python pipeline/total_return.py --compare         # effect on the backtest
```

`--compare` reports the number that actually matters — **top-decile churn**:
how many names enter or leave the top 10% when scored on total return
instead of price return. Near zero means the gap only shifts the level.
Materially above zero means it changes what the strategy buys.

### Applying it

`fwd_total_return()` is a drop-in replacement: same signature, same `None`
semantics, same delisting fallback. Only the column changes.

```python
# screener_backtest_v3.py (and _v2, and the original)
from pipeline.total_return import fwd_total_return

def fwd_return(conn, stock_id, start_date, days):
    return fwd_total_return(conn, stock_id, start_date, days)
```

Leave `fetch_at()` alone — its `SELECT date, close, volume` feeds signals.

It falls back to `close` wherever `adj_close` is NULL, so a partially adjusted
series degrades to today's behaviour for those bars rather than dropping the
observation.

> Re-running a backtest after this will report **higher** returns than before.
> That is the dividend income the old measurement was discarding, not an
> improvement in the strategy — don't compare a post-patch run against a
> pre-patch one.

---

## 2. Every ticker in at least one index

`update_stock_data.py --memberships-only` populates six index loaders
(SP500/SP400/NDX/RUI/RUT/RUA) plus two exchange-derived indices (NYSE from
`exchange = 'NYQ'`, IXIC from `NGM/NCM/NMS`). Everything else — NYSE American,
Arca, Cboe, OTC venues, ETFs, and any ticker whose exchange code is null or
unrecognised — lands in **no index at all**.

Orphans are invisible to every `--source db` universe query. That matters
because `sp500_members_at()` deliberately reaches back to constituents that
have since been *removed*: a point-in-time backtest asks for them by name and
cannot price them, so it silently drops them — reintroducing exactly the
survivorship bias the history table exists to remove.

```bash
python pipeline/index_coverage.py --report    # what you have now
python pipeline/index_coverage.py             # dry run, shows the plan
python pipeline/index_coverage.py --apply
```

Adds venue, asset-class and catch-all indices. Multi-index membership is
preserved throughout — a ticker is normally in several at once
(`AAPL → SP500, NDX, RUI, RUA, IXIC, ALLUS`).

| Index | Membership |
|---|---|
| `NYSE` `IXIC` `AMEX` `ARCA` `BATS` `OTC` | by `stocks.exchange` |
| `ETF` | `is_etf = true` — orthogonal to venue, an ETF is in both |
| `TEST` | `test_issue = 'Y'` — classified so it stops looking like an orphan, but deliberately **excluded from `ALLUS`** so no universe query can trade one |
| `UNKNOWN` | exchange code absent or not in the map — a **diagnostic**, not a dumping ground |
| `ALLUS` | every tradable ticker; the guarantee that makes "orphan" impossible |

`--report` names the exchange codes that landed in `UNKNOWN` so
`EXCHANGE_INDEX` in `index_coverage.py` can be extended. That set should trend
toward empty; anything in it is a real gap in the map.

The migration also declares `NYSE` and `IXIC` in `stock_indices`. They are
referenced by `update_stock_data.py` but declared in no migration — on the live
DB they were created ad-hoc, and on a database rebuilt from `migrations/`,
`refresh_memberships()` prints `! not in stock_indices — skipping` and moves
on. Two whole venues, silently unpopulated.

---

## 3. Membership dates

`stock_index_members` already carries `added_date` / `removed_date` /
`is_active`. Two things were missing.

**Nothing enforced one active row per (stock, index).** The existing key is
`(stock_id, index_id, added_date)`, which is right for history — a ticker
removed in March and re-added in July *should* have two rows — but it permits
two rows both flagged active, which double-weights the name in any
equal-weight universe build. Migration 007 deduplicates and adds a partial
unique index on `(stock_id, index_id) WHERE is_active`.

**`_upsert_membership` never wrote to `index_constituent_history`.** Only the
one-off backfill scripts did, so every ongoing change vanished.
`index_coverage.py` records both sides of every transition, tagged
`source='reconcile'` so an observed change can be told apart from scraped
history — the two do not deserve equal trust.

### Where `added_date` comes from

Stamping every first-time membership with `today` would assert that 11,000
tickers joined their venue on the day the script first ran, making
`index_membership_spans` useless for all prior history. Resolution order:

1. an existing `'added'` event in `index_constituent_history` (the backfill
   scripts know the real S&P/NDX dates)
2. **on the initial population only**, the ticker's first price date — the
   honest answer for a membership that means "this ticker exists and trades
   here"
3. today

Step 2 is restricted to the initial run deliberately. Once an index is
populated, a new member is something reconciliation just *observed*;
back-dating it to the ticker's first price would invent years of membership
that never happened.

Removals are always dated the day they are observed, because that is the only
thing actually known — reconciliation sees that a ticker is gone, not when it
left.

### Querying it

```sql
-- membership as intervals
SELECT * FROM index_membership_spans WHERE ticker = 'AAPL';

 ticker | index_symbol | added_date | removed_date | is_active | days_held
--------+--------------+------------+--------------+-----------+-----------
 AAPL   | NYSE         | 2023-08-02 | 2026-03-15   | f         |       956
 AAPL   | NYSE         | 2026-06-20 |              | t         |        42

-- point in time, any index
SELECT * FROM index_members_at('SP500', '2019-06-30');   -- replays the event log
SELECT * FROM index_members_on('SP500', '2019-06-30');   -- reads the intervals
```

`index_members_at()` replays the event log and reaches as far back as the log
goes. `index_members_on()` reads the interval table — exact and cheaper, but
only as deep as interval tracking.

### A bug this fixes in `sp500_members_at()`

Migration 002's function is:

```sql
current_members UNION (removed after T) EXCEPT (added after T)
```

A ticker that left in March and rejoined in June has **both** a `removed` and
an `added` event after January. `EXCEPT` is applied last, so the `added` event
wins and the ticker is reported as absent in January — when it was in fact a
member. Leave-and-return is not rare (spin-offs, M&A that unwinds, index
reshuffles), and each occurrence silently drops a real holding out of a
point-in-time backtest.

The fix is to consider only each ticker's **next** change after the target
date:

| next change after T | was it a member at T? |
|---|---|
| `removed` | yes — it had to be there to be removed later |
| `added` | no |
| none | same as today |

Correct for any number of transitions. Migration 007 redefines
`sp500_members_at()` to delegate to the corrected `index_members_at()`, so
every existing caller — `screener_backtest_v3.py:249` and both backfill
scripts — inherits the fix without a code change.

---

## Verifying

```bash
python db_health_check.py --only returns --only indices --only coverage
python pipeline/index_coverage.py --report
```

`inv.orphan_tickers` and `cover.survivorship` in the health checker are the
two that should move once these are applied.
