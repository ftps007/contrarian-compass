-- Migration 007 — complete index coverage + membership date integrity
--
-- Two problems this fixes.
--
-- 1. ORPHANS. update_stock_data.py assigns membership from six index loaders
--    (SP500/SP400/NDX/RUI/RUT/RUA) plus two exchange-derived indices
--    (NYSE <- exchange 'NYQ', IXIC <- 'NGM','NCM','NMS'). Everything else --
--    NYSE American, Arca, Cboe, OTC venues, ETFs, and any ticker whose
--    exchange code is null or unrecognised -- lands in no index at all.
--    Those tickers are invisible to every `--source db` universe query, which
--    matters because sp500_members_at() deliberately reaches back to
--    constituents that have since been removed: a point-in-time backtest asks
--    for them by name and cannot price them.
--
-- 2. MEMBERSHIP DATES. stock_index_members already carries added_date /
--    removed_date / is_active, but nothing enforces one active row per
--    (stock_id, index_id), and _upsert_membership never writes to
--    index_constituent_history -- so the audit log only ever contains what the
--    one-off backfill scripts put there, and ongoing changes vanish.
--
-- Apply with:
--   psql -d stock_data -f pipeline/migrations/007_index_coverage.sql
--
-- Safe to re-run.

BEGIN;

-- ── 1. Venue, asset-class and catch-all indices ───────────────────────────
--
-- ALLUS is the guarantee: every ticker joins it by construction, so "orphan"
-- becomes impossible rather than merely unlikely. UNCLASSIFIED is the
-- diagnostic that tells you which exchange codes still need mapping — it
-- should trend toward empty, and anything in it is a real gap in the map.

-- stock_indices.symbol is VARCHAR(10) in the shipped schema; the new symbols
-- are all <= 7 chars, but widen defensively so this cannot fail on a variant.
--
-- The widen has to happen before index_membership_spans exists, because a view
-- that selects the column pins its type. Dropping and recreating the view is
-- what makes this migration genuinely re-runnable -- without it a second run
-- aborts on "cannot alter type of a column used by a view", and because the
-- whole file is one transaction, every later statement is skipped too.
DROP VIEW IF EXISTS index_membership_spans;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'stock_indices' AND column_name = 'symbol'
           AND character_maximum_length IS NOT NULL
           AND character_maximum_length < 20
    ) THEN
        ALTER TABLE stock_indices ALTER COLUMN symbol TYPE VARCHAR(20);
    END IF;
END $$;

-- NYSE and IXIC are referenced by update_stock_data.py's exchange-derived
-- rules but are declared in no migration. On the live DB they were created
-- ad-hoc; on a rebuilt one they would be absent, and refresh_memberships()
-- handles that by printing "! not in stock_indices — skipping" and moving on.
-- Two whole venues would then be silently unpopulated. Declare them here.
INSERT INTO stock_indices (symbol, name) VALUES
    ('NYSE',    'NYSE Composite (exchange-derived)'),
    ('IXIC',    'NASDAQ Composite (exchange-derived)'),
    ('AMEX',    'NYSE American (AMEX)'),
    ('ARCA',    'NYSE Arca'),
    ('BATS',    'Cboe BZX'),
    ('OTC',     'Over-the-counter (Pink / OTCQB / OTCQX)'),
    ('INDEXES', 'Market indices (^GSPC, ^VIX, ...)'),
    ('ETF',     'Exchange-traded funds and notes'),
    ('TEST',    'Exchange test issues (not tradable)'),
    ('UNKNOWN', 'Exchange code absent or not yet mapped'),
    ('ALLUS',   'Catch-all: every tradable ticker in stocks')
ON CONFLICT (symbol) DO NOTHING;

-- ── 2. Membership keys ────────────────────────────────────────────────────
--
-- update_stock_data.py's _upsert_membership does
--   ON CONFLICT (stock_id, index_id, added_date) DO NOTHING
-- which requires a unique constraint on exactly those columns. It exists on
-- the live DB but is not declared in any migration, so a rebuilt-from-scratch
-- database would raise on the first membership refresh. Declare it here.
-- IF NOT EXISTS only checks the NAME. The live database already enforces this
-- key under an auto-generated constraint name
-- (stock_index_members_stock_id_index_id_added_date_key), so creating it here
-- by a different name produced a second, identical unique index — visible as
-- schema.redundant_indexes going from 5 to 6. Check for the columns, not the
-- name.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indrelid
         WHERE c.relname = 'stock_index_members'
           AND i.indisunique
           AND i.indnatts = 3
           -- attname is `name`, not `text`; without the cast the comparison
           -- raises "operator does not exist: name[] = text[]", and because
           -- this whole file is one transaction that error takes every
           -- statement after it down with it.
           AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                  FROM unnest(i.indkey) k
                  JOIN pg_attribute a
                    ON a.attrelid = i.indrelid AND a.attnum = k)
               = ARRAY['added_date', 'index_id', 'stock_id']
    ) THEN
        CREATE UNIQUE INDEX uq_index_members_stock_index_added
            ON stock_index_members (stock_id, index_id, added_date);
    END IF;
END $$;

-- Undo the duplicate if an earlier run of this migration created it.
DROP INDEX IF EXISTS uq_index_members_stock_index_added_dup;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uq_index_members_stock_index_added')
       AND EXISTS (SELECT 1 FROM pg_class
                    WHERE relname = 'stock_index_members_stock_id_index_id_added_date_key')
    THEN
        DROP INDEX uq_index_members_stock_index_added;
        RAISE NOTICE 'dropped duplicate uq_index_members_stock_index_added';
    END IF;
END $$;

-- ── 2b. One ACTIVE membership per (stock, index) ──────────────────────────
--
-- The existing key is (stock_id, index_id, added_date), which is correct for
-- slowly-changing history: a ticker removed in March and re-added in July
-- SHOULD have two rows. What it does not prevent is two rows both flagged
-- active, which double-weights the name in any equal-weight universe build.
-- A partial unique index constrains exactly that and nothing else.
--
-- Deduplicate first, keeping the most recently added row.
WITH ranked AS (
    SELECT ctid,
           ROW_NUMBER() OVER (PARTITION BY stock_id, index_id
                                  ORDER BY added_date DESC NULLS LAST, ctid DESC) AS rn
      FROM stock_index_members
     WHERE is_active
)
UPDATE stock_index_members m
   SET is_active = false,
       removed_date = COALESCE(m.removed_date, CURRENT_DATE)
  FROM ranked r
 WHERE m.ctid = r.ctid AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_index_members_active
    ON stock_index_members (stock_id, index_id)
 WHERE is_active;

-- ── 3. Membership history integrity ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS index_constituent_history (
    id          SERIAL PRIMARY KEY,
    index_id    INTEGER REFERENCES stock_indices(id) ON DELETE CASCADE,
    ticker      VARCHAR(20),
    action      VARCHAR(10),
    action_date DATE,
    reason      TEXT
);

ALTER TABLE index_constituent_history
    ADD COLUMN IF NOT EXISTS reason TEXT,
    ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMP DEFAULT now(),
    -- Where the event came from: 'wikipedia', 'ishares', 'exchange',
    -- 'reconcile' (observed by the updater), 'backfill'. Without it a
    -- scraped historical event and an observed live one are indistinguishable,
    -- and they do not deserve equal trust.
    ADD COLUMN IF NOT EXISTS source TEXT;

-- Idempotency: re-running a reconciliation on the same day must not append a
-- duplicate event. Without this the history table grows by one row per index
-- per run and the "changes per year" sanity check in the health checker
-- becomes meaningless.
CREATE UNIQUE INDEX IF NOT EXISTS uq_constituent_history_event
    ON index_constituent_history (index_id, ticker, action, action_date);

CREATE INDEX IF NOT EXISTS idx_constituent_history_lookup
    ON index_constituent_history (index_id, action_date DESC);

-- ── 4. Point-in-time membership — generalised AND corrected ───────────────
--
-- sp500_members_at() (migration 002) is hardcoded to SP500, and its set
-- algebra is wrong for any ticker that leaves and later returns:
--
--     current_members UNION (removed after T) EXCEPT (added after T)
--
-- A ticker that left in March and rejoined in June has BOTH a 'removed' and
-- an 'added' event after January. EXCEPT is applied last, so the 'added'
-- event wins and the ticker is reported as absent in January — when it was
-- in fact a member. Deletions-and-readditions are not rare (spin-offs,
-- M&A that unwinds, index reshuffles), and each one silently drops a real
-- holding out of a point-in-time backtest.
--
-- The fix is to look only at each ticker's NEXT change after the target
-- date, not at all of them:
--
--     next change is 'removed'  -> it was a member at T (it had to be there
--                                  in order to be removed later)
--     next change is 'added'    -> it was not a member at T
--     no future change          -> same as today
--
-- That is correct for any number of transitions.
CREATE OR REPLACE FUNCTION index_members_at(index_symbol TEXT, target_date DATE)
RETURNS TABLE (ticker VARCHAR) LANGUAGE sql STABLE AS $$
    WITH idx AS (
        SELECT id FROM stock_indices WHERE symbol = index_symbol LIMIT 1
    ),
    next_change AS (
        SELECT DISTINCT ON (h.ticker) h.ticker, h.action
          FROM index_constituent_history h
         WHERE h.index_id = (SELECT id FROM idx)
           AND h.action_date > target_date
         ORDER BY h.ticker, h.action_date ASC, h.id ASC
    ),
    current_members AS (
        SELECT s.ticker
          FROM stocks s
          JOIN stock_index_members m ON m.stock_id = s.id
         WHERE m.index_id = (SELECT id FROM idx) AND m.is_active = true
    )
    SELECT m.ticker::VARCHAR FROM (
        SELECT cm.ticker FROM current_members cm
        EXCEPT
        SELECT nc.ticker FROM next_change nc WHERE nc.action = 'added'
        UNION
        SELECT nc.ticker FROM next_change nc WHERE nc.action = 'removed'
    ) m;
$$;

-- Point the SP500 helper at the corrected implementation so every existing
-- caller (screener_backtest_v3.py:249 and the backfill scripts) inherits the
-- fix without a code change.
CREATE OR REPLACE FUNCTION sp500_members_at(target_date DATE)
RETURNS TABLE (ticker VARCHAR) LANGUAGE sql STABLE AS $$
    SELECT * FROM index_members_at('SP500', target_date);
$$;

-- Exact membership from the interval table. Cheaper and unambiguous, but only
-- as deep as interval tracking goes — use index_members_at() for dates that
-- predate it, where the scraped event log is the only evidence.
CREATE OR REPLACE FUNCTION index_members_on(index_symbol TEXT, target_date DATE)
RETURNS TABLE (ticker VARCHAR) LANGUAGE sql STABLE AS $$
    SELECT s.ticker::VARCHAR
      FROM stock_index_members m
      JOIN stocks s        ON s.id = m.stock_id
      JOIN stock_indices i  ON i.id = m.index_id
     WHERE i.symbol = index_symbol
       AND m.added_date <= target_date
       AND (m.removed_date IS NULL OR m.removed_date > target_date);
$$;

-- Membership as an interval, straight from stock_index_members. Answers
-- "when was X in Y, and for how long" without replaying the event log --
-- which is the question a rebalance or an attribution report actually asks.
CREATE OR REPLACE VIEW index_membership_spans AS
SELECT s.ticker,
       i.symbol       AS index_symbol,
       m.added_date,
       m.removed_date,
       m.is_active,
       COALESCE(m.removed_date, CURRENT_DATE) - m.added_date AS days_held
  FROM stock_index_members m
  JOIN stocks s        ON s.id = m.stock_id
  JOIN stock_indices i ON i.id = m.index_id
 ORDER BY s.ticker, i.symbol, m.added_date;

COMMENT ON INDEX uq_index_members_active IS
  'At most one active membership per (stock, index); history rows stay';
COMMENT ON VIEW index_membership_spans IS
  'Membership as (added_date, removed_date) intervals; see pipeline/README.md';

COMMIT;
