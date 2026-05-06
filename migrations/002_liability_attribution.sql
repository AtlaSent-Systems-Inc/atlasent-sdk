-- Migration 002: Liability Attribution
-- Creates the liability attribution record table.
-- Stores the immutable liability chain for every financial execution.

CREATE TABLE IF NOT EXISTS liability_attribution_records (
  attribution_id           TEXT        PRIMARY KEY,
  execution_id             TEXT        NOT NULL REFERENCES financial_execution_records(execution_id),
  org_id                   TEXT        NOT NULL,
  classification           TEXT        NOT NULL,
  risk_tier                TEXT        NOT NULL,
  liability_chain          JSONB       NOT NULL,  -- JSON array of LiabilityParty
  delegation_present       BOOLEAN     NOT NULL DEFAULT FALSE,
  supervisory_present      BOOLEAN     NOT NULL DEFAULT FALSE,
  emergency_override       BOOLEAN     NOT NULL DEFAULT FALSE,
  override_justification   TEXT,
  chain_hash               TEXT        NOT NULL,  -- SHA-256 of canonical chain
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lar_unique_execution UNIQUE (execution_id),
  CONSTRAINT lar_classification_chk CHECK (classification IN ('individual','shared','delegated','supervisory','emergency_override')),
  CONSTRAINT lar_risk_tier_chk CHECK (risk_tier IN ('low','medium','high','critical'))
);

CREATE INDEX idx_lar_org_id        ON liability_attribution_records (org_id);
CREATE INDEX idx_lar_execution_id  ON liability_attribution_records (execution_id);
CREATE INDEX idx_lar_emergency     ON liability_attribution_records (emergency_override) WHERE emergency_override = TRUE;
CREATE INDEX idx_lar_classification ON liability_attribution_records (classification);

COMMENT ON TABLE liability_attribution_records IS
  'Immutable liability chain for each financial execution. One record per execution. Chain weights sum to 1.0.';
