-- Migration 005: Budgetary Governance
-- Budget policies, limits, spending constraints, and spending state snapshots.

CREATE TABLE IF NOT EXISTS budget_policies (
  policy_id                     TEXT        PRIMARY KEY,
  org_id                        TEXT        NOT NULL,
  name                          TEXT        NOT NULL,
  override_requires_exception   BOOLEAN     NOT NULL DEFAULT TRUE,
  allow_approved_escalation     BOOLEAN     NOT NULL DEFAULT FALSE,
  version                       TEXT        NOT NULL,
  effective_from                TIMESTAMPTZ NOT NULL,
  expires_at                    TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bp_org_id ON budget_policies (org_id);

-- ─── Budget Limits ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_limits (
  limit_id      TEXT        PRIMARY KEY,
  policy_id     TEXT        NOT NULL REFERENCES budget_policies(policy_id),
  org_id        TEXT        NOT NULL,
  scope_type    TEXT        NOT NULL CHECK (scope_type IN ('org','department','team','environment','action_class','project','time_bounded')),
  scope_id      TEXT        NOT NULL,
  limit_amount  NUMERIC     NOT NULL CHECK (limit_amount >= 0),
  currency      TEXT        NOT NULL,
  enforcement   TEXT        NOT NULL CHECK (enforcement IN ('hard','soft')),
  period_start  TIMESTAMPTZ,
  period_end    TIMESTAMPTZ,
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by    TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bl_org_id    ON budget_limits (org_id);
CREATE INDEX idx_bl_scope     ON budget_limits (scope_type, scope_id);
CREATE INDEX idx_bl_active    ON budget_limits (active) WHERE active = TRUE;
CREATE INDEX idx_bl_period    ON budget_limits (period_start, period_end);

-- ─── Spending Constraints ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS spending_constraints (
  constraint_id            TEXT        PRIMARY KEY,
  policy_id                TEXT        NOT NULL REFERENCES budget_policies(policy_id),
  org_id                   TEXT        NOT NULL,
  action_type              TEXT        NOT NULL,  -- '*' = all types
  max_single_transaction   NUMERIC     NOT NULL CHECK (max_single_transaction >= 0),
  max_daily_aggregate      NUMERIC,
  max_monthly_aggregate    NUMERIC,
  currency                 TEXT        NOT NULL,
  applies_to_tier_gte      TEXT,
  allow_anonymous_agents   BOOLEAN     NOT NULL DEFAULT TRUE,
  active                   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sc_org_id      ON spending_constraints (org_id);
CREATE INDEX idx_sc_action_type ON spending_constraints (action_type);
CREATE INDEX idx_sc_active      ON spending_constraints (active) WHERE active = TRUE;

COMMENT ON TABLE spending_constraints IS
  'Per-action-type spending constraints. action_type = ''*'' applies to all types.';
