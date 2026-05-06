-- Migration 003: Economic Risk Scores
-- Append-only table for computed financial risk scores.
-- Partitioned by org_id for efficient per-org queries.

CREATE TABLE IF NOT EXISTS financial_risk_scores (
  score_id              TEXT        PRIMARY KEY,
  scope_id              TEXT        NOT NULL,
  org_id                TEXT        NOT NULL,
  overall_score         NUMERIC     NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
  exposure_score        NUMERIC     NOT NULL,
  concentration_score   NUMERIC     NOT NULL,
  override_score        NUMERIC     NOT NULL,
  drift_score           NUMERIC     NOT NULL,
  anomaly_score         NUMERIC     NOT NULL,
  implied_tier          TEXT        NOT NULL CHECK (implied_tier IN ('low','medium','high','critical')),
  factors               JSONB       NOT NULL DEFAULT '[]',
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_frs_org_id     ON financial_risk_scores (org_id);
CREATE INDEX idx_frs_scope_id   ON financial_risk_scores (scope_id);
CREATE INDEX idx_frs_computed   ON financial_risk_scores (computed_at DESC);
CREATE INDEX idx_frs_tier       ON financial_risk_scores (implied_tier);

COMMENT ON TABLE financial_risk_scores IS
  'Append-only computed financial risk scores. New score written on each evaluation cycle. Historical scores are preserved.';

-- ─── Execution Anomalies ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS execution_anomalies (
  anomaly_id      TEXT        PRIMARY KEY,
  execution_id    TEXT        NOT NULL REFERENCES financial_execution_records(execution_id),
  org_id          TEXT        NOT NULL,
  anomaly_type    TEXT        NOT NULL,
  description     TEXT        NOT NULL,
  severity        TEXT        NOT NULL CHECK (severity IN ('low','medium','high')),
  evidence        JSONB       NOT NULL DEFAULT '{}',
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ea_execution_id ON execution_anomalies (execution_id);
CREATE INDEX idx_ea_org_id       ON execution_anomalies (org_id);
CREATE INDEX idx_ea_severity     ON execution_anomalies (severity);
CREATE INDEX idx_ea_detected_at  ON execution_anomalies (detected_at DESC);
