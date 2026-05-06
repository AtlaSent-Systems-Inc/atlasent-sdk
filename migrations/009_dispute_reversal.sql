-- Migration 009: Dispute + Reversal Workflows and Action Freezes

CREATE TABLE IF NOT EXISTS dispute_records (
  dispute_id              TEXT        PRIMARY KEY,
  execution_id            TEXT        NOT NULL REFERENCES financial_execution_records(execution_id),
  org_id                  TEXT        NOT NULL,
  origin                  TEXT        NOT NULL CHECK (origin IN ('counterparty','regulator','internal_audit','fraud_detection','approver_retract','policy_violation','agent_error')),
  filed_by                TEXT        NOT NULL,
  description             TEXT        NOT NULL,
  status                  TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','escalated','resolved_in_favor','resolved_against','reversed','withdrawn')),
  execution_frozen        BOOLEAN     NOT NULL DEFAULT FALSE,
  opened_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolution_deadline     TIMESTAMPTZ,
  resolved_at             TIMESTAMPTZ,
  resolved_by             TEXT,
  resolution_notes        TEXT,
  reversal_initiated      BOOLEAN     NOT NULL DEFAULT FALSE,
  reversal_id             TEXT
);

CREATE INDEX idx_dr_org_id       ON dispute_records (org_id);
CREATE INDEX idx_dr_execution_id ON dispute_records (execution_id);
CREATE INDEX idx_dr_status       ON dispute_records (status);
CREATE INDEX idx_dr_open         ON dispute_records (status) WHERE status IN ('open','under_review','escalated');
CREATE INDEX idx_dr_opened_at    ON dispute_records (opened_at DESC);
CREATE INDEX idx_dr_deadline     ON dispute_records (resolution_deadline) WHERE resolution_deadline IS NOT NULL;

COMMENT ON TABLE dispute_records IS
  'Financial action disputes. State machine transitions validated by the SDK. Terminal states: resolved_in_favor, resolved_against, reversed, withdrawn.';

-- ─── Reversal Workflows ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reversal_workflows (
  reversal_id               TEXT        PRIMARY KEY,
  execution_id              TEXT        NOT NULL REFERENCES financial_execution_records(execution_id),
  dispute_id                TEXT        REFERENCES dispute_records(dispute_id),
  org_id                    TEXT        NOT NULL,
  initiated_by              TEXT        NOT NULL,
  reason                    TEXT        NOT NULL,
  stage                     TEXT        NOT NULL DEFAULT 'initiated' CHECK (stage IN ('initiated','authorization_pending','authorized','executing','completed','failed','cancelled')),
  authorized_by             TEXT,
  authorization_permit_id   TEXT,
  initiated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  authorized_at             TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  reversal_value            NUMERIC     NOT NULL CHECK (reversal_value >= 0),
  partial                   BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_rw_org_id       ON reversal_workflows (org_id);
CREATE INDEX idx_rw_execution_id ON reversal_workflows (execution_id);
CREATE INDEX idx_rw_stage        ON reversal_workflows (stage);
CREATE INDEX idx_rw_pending      ON reversal_workflows (stage) WHERE stage IN ('initiated','authorization_pending','authorized','executing');

COMMENT ON TABLE reversal_workflows IS
  'Reversal state machine records. Stage transitions validated by the SDK. Reversal to executing requires authorization_permit_id.';

-- ─── Action Freezes ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS action_freezes (
  freeze_id       TEXT        PRIMARY KEY,
  execution_id    TEXT        NOT NULL REFERENCES financial_execution_records(execution_id),
  org_id          TEXT        NOT NULL,
  triggered_by    TEXT        NOT NULL,
  reason          TEXT        NOT NULL,
  triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,
  lifted          BOOLEAN     NOT NULL DEFAULT FALSE,
  lifted_at       TIMESTAMPTZ,
  lifted_by       TEXT,
  frozen_status   TEXT        NOT NULL DEFAULT 'frozen'
);

CREATE INDEX idx_af_execution_id ON action_freezes (execution_id);
CREATE INDEX idx_af_org_id       ON action_freezes (org_id);
CREATE INDEX idx_af_active       ON action_freezes (lifted) WHERE lifted = FALSE;

COMMENT ON TABLE action_freezes IS
  'Per-execution freeze records. A freeze blocks further status transitions until lifted or expired.';
