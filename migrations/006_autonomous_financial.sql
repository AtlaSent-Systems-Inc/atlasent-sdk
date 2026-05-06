-- Migration 006: Autonomous Financial Execution
-- Agent bounds declarations and execution audit trail.

CREATE TABLE IF NOT EXISTS autonomous_execution_bounds (
  bounds_id                    TEXT        PRIMARY KEY,
  org_id                       TEXT        NOT NULL,
  agent_id                     TEXT        NOT NULL,
  agent_name                   TEXT        NOT NULL,
  permitted_action_types       TEXT[]      NOT NULL DEFAULT '{}',
  ceilings                     JSONB       NOT NULL DEFAULT '[]',
  daily_aggregate_ceiling      NUMERIC     NOT NULL CHECK (daily_aggregate_ceiling >= 0),
  aggregate_currency           TEXT        NOT NULL DEFAULT 'USD',
  max_risk_tier                TEXT        NOT NULL CHECK (max_risk_tier IN ('low','medium','high','critical')),
  require_runtime_verification BOOLEAN     NOT NULL DEFAULT TRUE,
  anomaly_detection_enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  expires_at                   TIMESTAMPTZ,
  active                       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_aeb_org_id   ON autonomous_execution_bounds (org_id);
CREATE INDEX idx_aeb_agent_id ON autonomous_execution_bounds (agent_id);
CREATE INDEX idx_aeb_active   ON autonomous_execution_bounds (active) WHERE active = TRUE;

COMMENT ON TABLE autonomous_execution_bounds IS
  'Declared authority bounds for autonomous financial agents. Agents may only execute action types and values within their declared bounds.';

-- ─── Autonomous Execution Records ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS autonomous_execution_records (
  record_id             TEXT        PRIMARY KEY,
  bounds_id             TEXT        NOT NULL REFERENCES autonomous_execution_bounds(bounds_id),
  agent_id              TEXT        NOT NULL,
  org_id                TEXT        NOT NULL,
  action_type           TEXT        NOT NULL,
  action_value          NUMERIC     NOT NULL CHECK (action_value >= 0),
  currency              TEXT        NOT NULL,
  permitted             BOOLEAN     NOT NULL,
  denial_reason         TEXT,
  permit_id             TEXT,
  anomaly_detected      BOOLEAN     NOT NULL DEFAULT FALSE,
  anomaly_description   TEXT,
  attempted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at           TIMESTAMPTZ
);

CREATE INDEX idx_aer_agent_id     ON autonomous_execution_records (agent_id);
CREATE INDEX idx_aer_org_id       ON autonomous_execution_records (org_id);
CREATE INDEX idx_aer_permitted    ON autonomous_execution_records (permitted);
CREATE INDEX idx_aer_anomaly      ON autonomous_execution_records (anomaly_detected) WHERE anomaly_detected = TRUE;
CREATE INDEX idx_aer_attempted_at ON autonomous_execution_records (attempted_at DESC);
