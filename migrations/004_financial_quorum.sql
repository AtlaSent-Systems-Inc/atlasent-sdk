-- Migration 004: Financial Quorum Policies and Emergency Freezes

CREATE TABLE IF NOT EXISTS financial_quorum_policies (
  policy_id                       TEXT        PRIMARY KEY,
  org_id                          TEXT        NOT NULL,
  name                            TEXT        NOT NULL,
  required_count                  INTEGER     NOT NULL CHECK (required_count >= 1),
  financial_role_requirements     JSONB       NOT NULL DEFAULT '[]',
  amount_thresholds               JSONB       NOT NULL DEFAULT '[]',
  reference_currency              TEXT        NOT NULL DEFAULT 'USD',
  emergency_freeze_active         BOOLEAN     NOT NULL DEFAULT FALSE,
  regulator_approval_threshold    NUMERIC,
  dual_release_threshold          NUMERIC,
  active                          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fqp_org_id  ON financial_quorum_policies (org_id);
CREATE INDEX idx_fqp_active  ON financial_quorum_policies (active) WHERE active = TRUE;

COMMENT ON TABLE financial_quorum_policies IS
  'Financial quorum policy definitions. Extends base quorum with amount thresholds and financial role requirements.';

-- ─── Emergency Freezes ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS emergency_freezes (
  freeze_id     TEXT        PRIMARY KEY,
  org_id        TEXT        NOT NULL,
  scope_id      TEXT        NOT NULL,
  scope_type    TEXT        NOT NULL CHECK (scope_type IN ('org','department','action_class')),
  triggered_by  TEXT        NOT NULL,
  reason        TEXT        NOT NULL,
  triggered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  lifted        BOOLEAN     NOT NULL DEFAULT FALSE,
  lifted_at     TIMESTAMPTZ,
  lifted_by     TEXT
);

CREATE INDEX idx_ef_org_id      ON emergency_freezes (org_id);
CREATE INDEX idx_ef_scope_id    ON emergency_freezes (scope_id);
CREATE INDEX idx_ef_active      ON emergency_freezes (lifted) WHERE lifted = FALSE;
CREATE INDEX idx_ef_triggered   ON emergency_freezes (triggered_at DESC);

COMMENT ON TABLE emergency_freezes IS
  'Emergency freeze records. An active (not lifted) freeze blocks all financial executions in its scope.';
