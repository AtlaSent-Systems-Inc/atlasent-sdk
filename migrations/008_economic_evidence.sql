-- Migration 008: Economic Evidence Bundles
-- Stores metadata and content hashes for signed evidence bundles.
-- Full bundle content is stored in object storage; only metadata here.

CREATE TABLE IF NOT EXISTS economic_evidence_bundles (
  bundle_id               TEXT        PRIMARY KEY,
  org_id                  TEXT        NOT NULL,
  execution_id            TEXT        NOT NULL REFERENCES financial_execution_records(execution_id),
  attribution_id          TEXT        NOT NULL REFERENCES liability_attribution_records(attribution_id),
  purpose                 TEXT        NOT NULL CHECK (purpose IN ('regulator_review','insurance_review','financial_audit','legal_discovery','internal_review','dispute_resolution')),
  runtime_conformity      BOOLEAN     NOT NULL,
  policy_compliant        BOOLEAN     NOT NULL,
  approval_count          INTEGER     NOT NULL,
  content_hash            TEXT        NOT NULL,  -- SHA-256 hex of canonical bundle content
  signature               TEXT,                 -- Base64url Ed25519
  signing_key_id          TEXT,
  generated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_by            TEXT        NOT NULL,
  storage_uri             TEXT                  -- Object storage URI for full bundle
);

CREATE INDEX idx_eeb_org_id          ON economic_evidence_bundles (org_id);
CREATE INDEX idx_eeb_execution_id    ON economic_evidence_bundles (execution_id);
CREATE INDEX idx_eeb_purpose         ON economic_evidence_bundles (purpose);
CREATE INDEX idx_eeb_generated_at    ON economic_evidence_bundles (generated_at DESC);
CREATE INDEX idx_eeb_policy_comply   ON economic_evidence_bundles (policy_compliant);

COMMENT ON TABLE economic_evidence_bundles IS
  'Metadata for signed economic evidence bundles. Full bundle JSON stored externally (object storage). content_hash and signature enable offline verification.';
