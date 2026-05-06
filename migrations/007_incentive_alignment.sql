-- Migration 007: Incentive Alignment Signals and Misalignment Alerts

CREATE TABLE IF NOT EXISTS incentive_signals (
  signal_id     TEXT        PRIMARY KEY,
  org_id        TEXT        NOT NULL,
  signal_type   TEXT        NOT NULL,
  party_id      TEXT        NOT NULL,
  party_label   TEXT        NOT NULL,
  severity      NUMERIC     NOT NULL CHECK (severity BETWEEN 0 AND 100),
  description   TEXT        NOT NULL,
  evidence      TEXT[]      NOT NULL DEFAULT '{}',
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed      BOOLEAN     NOT NULL DEFAULT FALSE,
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ
);

CREATE INDEX idx_is_org_id      ON incentive_signals (org_id);
CREATE INDEX idx_is_party_id    ON incentive_signals (party_id);
CREATE INDEX idx_is_signal_type ON incentive_signals (signal_type);
CREATE INDEX idx_is_severity    ON incentive_signals (severity DESC);
CREATE INDEX idx_is_unreviewed  ON incentive_signals (reviewed) WHERE reviewed = FALSE;
CREATE INDEX idx_is_detected_at ON incentive_signals (detected_at DESC);

COMMENT ON TABLE incentive_signals IS
  'Detected governance anti-patterns. Advisory only; does not block execution. Feeds into risk scores and dashboards.';

-- ─── Misalignment Alerts ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS misalignment_alerts (
  alert_id              TEXT        PRIMARY KEY,
  org_id                TEXT        NOT NULL,
  severity              TEXT        NOT NULL CHECK (severity IN ('warn','critical')),
  alert_type            TEXT        NOT NULL,
  affected_party_ids    TEXT[]      NOT NULL DEFAULT '{}',
  description           TEXT        NOT NULL,
  recommendation        TEXT        NOT NULL,
  signal_ids            TEXT[]      NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved              BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_at           TIMESTAMPTZ
);

CREATE INDEX idx_ma_org_id     ON misalignment_alerts (org_id);
CREATE INDEX idx_ma_severity   ON misalignment_alerts (severity);
CREATE INDEX idx_ma_unresolved ON misalignment_alerts (resolved) WHERE resolved = FALSE;
