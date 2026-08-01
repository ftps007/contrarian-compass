-- Test fixture: a miniature stock_data replica with deliberately seeded
-- defects, one per detector. build_fixture.py loads this, then seeds prices.
--
-- Mirrors the real schema documented in STOCK_DATA.md and migrations/000-005
-- of the tangency-portfolio repo: the same column names and types, the same
-- (stock_id, date) natural key expressed as UNIQUE NOT NULL rather than a
-- declared PRIMARY KEY (the live DB dropped its surrogate id in July 2026),
-- and the same two-index policy on price_data.

DROP VIEW  IF EXISTS current_fundamentals CASCADE;
DROP TABLE IF EXISTS price_data CASCADE;
DROP TABLE IF EXISTS stock_fundamentals CASCADE;
DROP TABLE IF EXISTS stock_financials CASCADE;
DROP TABLE IF EXISTS stock_catalysts CASCADE;
DROP TABLE IF EXISTS stock_index_members CASCADE;
DROP TABLE IF EXISTS index_constituent_history CASCADE;
DROP TABLE IF EXISTS stock_indices CASCADE;
DROP TABLE IF EXISTS stocks CASCADE;
DROP FUNCTION IF EXISTS sp500_members_at(DATE);

CREATE TABLE stocks (
    id          SERIAL PRIMARY KEY,
    ticker      VARCHAR(20) UNIQUE,
    name        TEXT,
    sector      TEXT,
    industry    TEXT,
    market_cap  BIGINT,
    exchange    VARCHAR(10),
    test_issue  CHAR(1),
    is_etf      BOOLEAN
);

-- Natural key as UNIQUE NOT NULL, matching the live database exactly.
CREATE TABLE price_data (
    stock_id   INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    date       DATE    NOT NULL,
    open       DOUBLE PRECISION,
    high       DOUBLE PRECISION,
    low        DOUBLE PRECISION,
    close      DOUBLE PRECISION,
    adj_close  DOUBLE PRECISION,
    volume     BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT price_data_stock_id_date_key UNIQUE (stock_id, date)
);
CREATE INDEX idx_date ON price_data (date);

-- The schema here is intentionally clean; build_fixture.py injects the
-- structural defects (a redundant index, a stale index last_updated) only
-- when it is asked for a defective fixture, so --clean can prove the checker
-- stays silent on a healthy database.

CREATE TABLE stock_indices (
    id           SERIAL PRIMARY KEY,
    symbol       VARCHAR(10) UNIQUE,
    name         TEXT,
    last_updated DATE
);

CREATE TABLE stock_index_members (
    stock_id     INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    index_id     INTEGER NOT NULL REFERENCES stock_indices(id) ON DELETE CASCADE,
    added_date   DATE,
    removed_date DATE,
    is_active    BOOLEAN DEFAULT TRUE
);

CREATE TABLE index_constituent_history (
    id          SERIAL PRIMARY KEY,
    index_id    INTEGER REFERENCES stock_indices(id),
    ticker      VARCHAR(20),
    action      VARCHAR(10),
    action_date DATE
);

CREATE TABLE stock_fundamentals (
    stock_id               INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    snapshot_date          DATE    NOT NULL,
    trailing_pe            NUMERIC(10, 2),
    forward_pe             NUMERIC(10, 2),
    price_to_book          NUMERIC(10, 2),
    operating_margin       NUMERIC(8, 4),
    fcf_ttm                BIGINT,
    debt_to_equity         NUMERIC(10, 2),
    roe                    NUMERIC(8, 4),
    revenue_growth_yoy     NUMERIC(8, 4),
    short_pct_float        NUMERIC(8, 4),
    recommendation_mean    NUMERIC(4, 2),
    days_to_earnings       INTEGER,
    market_cap             BIGINT,
    fetched_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    insider_net_buying_pct NUMERIC(8, 4),
    roic                   NUMERIC(8, 4),
    accruals_ratio         NUMERIC(8, 4),
    piotroski_f            SMALLINT,
    altman_z               NUMERIC(8, 2),
    beneish_m              NUMERIC(8, 2),
    institutions_pct_held  NUMERIC(8, 4),
    PRIMARY KEY (stock_id, snapshot_date)
);

CREATE VIEW current_fundamentals AS
SELECT DISTINCT ON (stock_id) *
  FROM stock_fundamentals
 ORDER BY stock_id, snapshot_date DESC;

CREATE TABLE stock_financials (
    stock_id      INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    fiscal_period DATE    NOT NULL,
    total_assets  BIGINT,
    net_income    BIGINT,
    cfo           BIGINT,
    fetched_at    TIMESTAMP DEFAULT now(),
    PRIMARY KEY (stock_id, fiscal_period)
);

CREATE TABLE stock_catalysts (
    id            SERIAL PRIMARY KEY,
    stock_id      INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    catalyst_date DATE    NOT NULL,
    type          VARCHAR(20) NOT NULL,
    direction     VARCHAR(10) NOT NULL,
    impact        INTEGER NOT NULL CHECK (impact BETWEEN 1 AND 5),
    summary       TEXT NOT NULL,
    detected_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (stock_id, catalyst_date, summary)
);

CREATE FUNCTION sp500_members_at(target_date DATE)
RETURNS TABLE (ticker VARCHAR) LANGUAGE sql STABLE AS $$
    WITH future_changes AS (
        SELECT h.ticker, h.action FROM index_constituent_history h
         WHERE h.index_id = (SELECT id FROM stock_indices WHERE symbol = 'SP500' LIMIT 1)
           AND h.action_date > target_date
    ),
    current_members AS (
        SELECT s.ticker
          FROM stocks s
          JOIN stock_index_members m ON m.stock_id = s.id
          JOIN stock_indices i ON i.id = m.index_id
         WHERE i.symbol = 'SP500' AND m.is_active = true
    )
    SELECT m.ticker::VARCHAR FROM (
        SELECT cm.ticker FROM current_members cm
        UNION
        SELECT fc.ticker FROM future_changes fc WHERE fc.action = 'removed'
        EXCEPT
        SELECT fc.ticker FROM future_changes fc WHERE fc.action = 'added'
    ) m;
$$;

INSERT INTO stock_indices (symbol, name, last_updated) VALUES
    ('SP500', 'S&P 500',      CURRENT_DATE),
    ('SP400', 'S&P MidCap',   CURRENT_DATE),
    ('RUA',   'Russell 3000', CURRENT_DATE),
    ('NDX',   'Nasdaq 100',   CURRENT_DATE);
