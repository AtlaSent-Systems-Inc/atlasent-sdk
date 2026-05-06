-- Migration 001: Financial Action Model
-- Creates the canonical financial action class registry and execution record table.
-- Immutable after insert; no UPDATE operations are permitted on execution_records.

CREATE TABLE IF NOT EXISTS financial_action_classes (
  action_class_id          TEXT        PRIMARY KEY,
  org_id                   TEXT        NOT NULL,
  name                     TEXT        NOT NULL,
  action_type              TEXT        NOT NULL,
  risk_tier                TEXT        NOT NULL CHECK (risk_tier IN ('low', 'medium', 'high', 'critical')),
  required_approvals       INTEGER     NOT NULL CHECK (required_approvals >= 1),
  liability_classification TEXT        NOT NULL CHECK (liability_classification IN ('individual', 'shared', 'delegated', 'supervisory', 'emergency_override')),
  reversible               BOOLEAN     NOT NULL DEFAULT TRUE,
  autonomous_ceiling       NUMERIC,
  ceiling_currency         TEXT,
  description              TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fac_risk_tier_chk     CHECK (risk_tier IN ('low','medium','high','critical')),
  CONSTRAINT fac_liability_chk     CHECK (liability_classification IN ('individual','shared','delegated','supervisory','emergency_override'))
);

CREATE INDEX idx_fac_org_id      ON financial_action_classes (org_id);
CREATE INDEX idx_fac_action_type ON financial_action_classes (action_type);
CREATE INDEX idx_fac_risk_tier   ON financial_action_classes (risk_tier);

COMMENT ON TABLE financial_action_classes IS
  'Canonical registry of financial action types. Defines risk tier, required approvals, and liability classification for each action class.';

-- ─── Financial Execution Records ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS financial_execution_records (
  execution_id              TEXT        PRIMARY KEY,
  action_class_id           TEXT        NOT NULL REFERENCES financial_action_classes(action_class_id),
  org_id                    TEXT        NOT NULL,
  action_value              NUMERIC     NOT NULL CHECK (action_value >= 0),
  currency                  TEXT        NOT NULL,
  risk_tier                 TEXT        NOT NULL,
  liability_classification  TEXT        NOT NULL,
  initiator_id              TEXT        NOT NULL,
  executor_id               TEXT        NOT NULL,
  approver_ids              TEXT[]      NOT NULL DEFAULT '{}',
  permit_ids                TEXT[]      NOT NULL DEFAULT '{}',
  override_applied          BOOLEAN     NOT NULL DEFAULT FALSE,
  override_id               TEXT,
  status                    TEXT        NOT NULL DEFAULT 'pending_approval',
  authorized_at             TIMESTAMPTZ NOT NULL,
  executed_at               TIMESTAMPTZ,
  audit_hash                TEXT        NOT NULL,
  context                   JSONB       NOT NULL DEFAULT '{}',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fer_status_chk CHECK (status IN ('pending_approval','approved','executing','completed','failed','reversed','disputed','frozen')),
  CONSTRAINT fer_risk_tier_chk CHECK (risk_tier IN ('low','medium','high','critical'))
);

CREATE INDEX idx_fer_org_id          ON financial_execution_records (org_id);
CREATE INDEX idx_fer_status          ON financial_execution_records (status);
CREATE INDEX idx_fer_authorized_at   ON financial_execution_records (authorized_at DESC);
CREATE INDEX idx_fer_initiator_id    ON financial_execution_records (initiator_id);
CREATE INDEX idx_fer_executor_id     ON financial_execution_records (executor_id);
CREATE INDEX idx_fer_risk_tier       ON financial_execution_records (risk_tier);
CREATE INDEX idx_fer_override        ON financial_execution_records (override_applied) WHERE override_applied = TRUE;

COMMENT ON TABLE financial_execution_records IS
  'Immutable audit trail of financial action executions. Append-only; no UPDATE operations permitted.';
