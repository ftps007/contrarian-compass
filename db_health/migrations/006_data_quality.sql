-- Migration 006 — data quality run history
--
-- Records every db_health_check.py run so the health score can be trended.
-- A one-off report tells you today's state; the trend tells you whether a
-- change (a new ticker cohort, a schema tweak, a vacuum setting) helped or
-- hurt — and it timestamps the first run where a defect appeared, which is
-- usually enough to identify what introduced it.
--
-- Apply with:
--   psql -d stock_data -f db_health/migrations/006_data_quality.sql
--
-- Numbered 006 to follow the migrations/ series in the tangency-portfolio
-- repo (000_price_data … 005_value_trap_scores).

CREATE TABLE IF NOT EXISTS data_quality_runs (
    id            BIGSERIAL   PRIMARY KEY,
    started_at    TIMESTAMPTZ NOT NULL,
    duration_ms   DOUBLE PRECISION,
    profile       TEXT        NOT NULL,
    universe      TEXT        NOT NULL,
    window_days   INTEGER,
    -- Worst status across all checks: PASS | INFO | WARN | FAIL | ERROR
    status        TEXT        NOT NULL,
    -- 0-100; WARN costs 1 unit, FAIL/ERROR cost 4 (see RunResult.score)
    score         NUMERIC(5, 1),
    n_pass        INTEGER     NOT NULL DEFAULT 0,
    n_info        INTEGER     NOT NULL DEFAULT 0,
    n_warn        INTEGER     NOT NULL DEFAULT 0,
    n_fail        INTEGER     NOT NULL DEFAULT 0,
    n_error       INTEGER     NOT NULL DEFAULT 0,
    n_skip        INTEGER     NOT NULL DEFAULT 0,
    -- which database this run inspected, e.g. stock_data@localhost:5432
    target        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dq_runs_started
  ON data_quality_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS data_quality_findings (
    id          BIGSERIAL PRIMARY KEY,
    run_id      BIGINT    NOT NULL REFERENCES data_quality_runs(id) ON DELETE CASCADE,
    check_id    TEXT      NOT NULL,
    category    TEXT      NOT NULL,
    status      TEXT      NOT NULL,
    summary     TEXT,
    -- The check's own measurements (counts, ratios, dates) — queryable, so a
    -- single metric can be trended without re-parsing the summary text.
    metrics     JSONB,
    -- Offending rows, capped at --samples
    samples     JSONB,
    duration_ms DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_dq_findings_run
  ON data_quality_findings (run_id);
CREATE INDEX IF NOT EXISTS idx_dq_findings_check
  ON data_quality_findings (check_id, id DESC);
-- Partial index: the "what is broken right now" query only ever looks at
-- non-passing rows, and they are a small minority of the table.
CREATE INDEX IF NOT EXISTS idx_dq_findings_problems
  ON data_quality_findings (check_id, id DESC)
  WHERE status IN ('WARN', 'FAIL', 'ERROR');

-- Latest run per profile — what a dashboard reads.
CREATE OR REPLACE VIEW data_quality_latest AS
SELECT DISTINCT ON (profile, universe) *
  FROM data_quality_runs
 ORDER BY profile, universe, started_at DESC;

-- Per-check history, newest first. Answers "when did this check first start
-- failing?" — usually the fastest route to what caused it.
CREATE OR REPLACE VIEW data_quality_check_history AS
SELECT f.check_id, f.category, f.status, f.summary, f.metrics,
       r.started_at, r.profile, r.universe, r.id AS run_id
  FROM data_quality_findings f
  JOIN data_quality_runs r ON r.id = f.run_id
 ORDER BY f.check_id, r.started_at DESC;

COMMENT ON TABLE data_quality_runs IS
  'One row per db_health_check.py run; see db_health/README.md';
COMMENT ON TABLE data_quality_findings IS
  'One row per check per run, with metrics/samples as JSONB for trending';
