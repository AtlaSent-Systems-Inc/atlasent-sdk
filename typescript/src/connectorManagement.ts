/**
 * Connector management types: connector lifecycle, credential security,
 * enforcement policies, audit log, and sync state.
 *
 * Mirrors the `v1-connectors`, `v1-connector-enforcement` edge functions
 * and associated DB tables (connector_credentials, connector_enforcement_policies,
 * connector_audit_log, connector_sync_state).
 */

import type { RateLimitState } from "./types.js";

// ── Connector core ────────────────────────────────────────────────────────────

/** Supported external connector types. */
export type ConnectorType =
  | "github"
  | "stripe"
  | "slack"
  | "salesforce"
  | "jira"
  | "okta"
  | "aws"
  | "gcp"
  | "azure"
  | "ci_cd"
  | "custom"
  | (string & Record<never, never>);

/** Connector lifecycle status. */
export type ConnectorStatus =
  | "pending_install"
  | "active"
  | "syncing"
  | "error"
  | "revoked";

/** Full connector row returned by `GET /v1/governance/connectors`. */
export interface ConnectorRow {
  id: string;
  org_id: string;
  connector_type: ConnectorType;
  name: string;
  environment: string;
  status: ConnectorStatus;
  scopes: string[];
  config: Record<string, unknown>;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Credentials ───────────────────────────────────────────────────────────────

/** Credential type stored in connector_credentials. */
export type ConnectorCredentialType =
  | "oauth_token"
  | "api_key"
  | "webhook_secret"
  | "service_account"
  | "mtls_cert";

/**
 * Credential metadata row.
 * `encrypted_value` is never returned in API responses — only metadata is exposed.
 */
export interface ConnectorCredentialRow {
  id: string;
  org_id: string;
  connector_id: string;
  credential_type: ConnectorCredentialType;
  scope: string[];
  expires_at: string | null;
  rotated_at: string | null;
  rotated_by: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

// ── Enforcement policies ──────────────────────────────────────────────────────

/** Action a connector enforcement policy can require. */
export type EnforcementAction =
  | "require_permit"
  | "require_quorum"
  | "require_approval"
  | "block"
  | "audit_only";

/** Quorum configuration embedded in enforcement policies. */
export interface EnforcementQuorumConfig {
  min_approvers: number;
  required_roles?: string[];
  timeout_minutes?: number;
}

/** Single connector enforcement policy row. */
export interface ConnectorEnforcementPolicy {
  id: string;
  org_id: string;
  connector_type: ConnectorType;
  /** Event type that triggers policy evaluation (e.g. `"push"`, `"deploy"`, `"merge"`). */
  trigger_event: string;
  /** Declarative condition evaluated against the event payload. */
  condition: Record<string, unknown>;
  required_action: EnforcementAction;
  quorum_config: EnforcementQuorumConfig | null;
  /** Environments this policy applies to (e.g. `["production"]`). Empty = all. */
  environment_scope: string[];
  enabled: boolean;
  /** Higher priority policies are evaluated first. */
  priority: number;
  created_at: string;
  updated_at: string;
}

// ── Audit log ────────────────────────────────────────────────────────────────

/**
 * Single append-only connector audit log entry from `connector_audit_log`.
 * Entries are never updated or deleted — only inserted.
 */
export interface ConnectorAuditLogEntry {
  id: string;
  org_id: string;
  connector_id: string;
  actor_id: string | null;
  operation: string;
  /** `"success"` | `"failure"` | `"blocked"` */
  outcome: string;
  detail: Record<string, unknown>;
  ip_address: string | null;
  occurred_at: string;
}

// ── Sync state ────────────────────────────────────────────────────────────────

/** Sync state snapshot for a connector (one row per connector_id). */
export interface ConnectorSyncState {
  id: string;
  org_id: string;
  connector_id: string;
  last_sync_at: string | null;
  /** `"success"` | `"failure"` | `"running"` | `"skipped"` */
  last_sync_status: string | null;
  last_sync_error: string | null;
  /** Opaque cursor passed to the next incremental sync. */
  sync_cursor: Record<string, unknown> | null;
  next_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Enforcement evaluation ────────────────────────────────────────────────────

/** Input event for connector enforcement evaluation via `v1-connector-enforcement`. */
export interface ConnectorEnforcementEventInput {
  connector_id: string;
  event_type: string;
  actor_id?: string;
  environment?: string;
  payload?: Record<string, unknown>;
}

/** Result of a connector enforcement evaluation. */
export interface ConnectorEnforcementResult {
  /** Enforcement decision — fail-closed: defaults to `"block"` on evaluation error. */
  decision: "permit" | "block" | "require_quorum" | "require_approval" | "audit_only";
  policy_id: string | null;
  reason: string;
  audit_log_id: string | null;
  rateLimit: RateLimitState | null;
}

// ── Request / response shapes ─────────────────────────────────────────────────

/** Input for `installConnector()`. */
export interface InstallConnectorInput {
  connector_type: ConnectorType;
  name: string;
  environment: string;
  scopes?: string[];
  config?: Record<string, unknown>;
}

/** Input for `authenticateConnector()`. The `encrypted_value` must be pre-encrypted by the caller. */
export interface AuthenticateConnectorInput {
  credential_type: ConnectorCredentialType;
  /** Pre-encrypted credential value. Never transmit plaintext. */
  encrypted_value: string;
  scope?: string[];
  expires_at?: string;
}

/** Input for `upsertEnforcementPolicy()`. */
export interface UpsertEnforcementPolicyInput {
  connector_type: ConnectorType;
  trigger_event: string;
  condition?: Record<string, unknown>;
  required_action: EnforcementAction;
  quorum_config?: EnforcementQuorumConfig;
  environment_scope?: string[];
  enabled?: boolean;
  priority?: number;
}

/** Response from `listConnectors()`. */
export interface ListConnectorsResponse {
  connectors: ConnectorRow[];
  total: number;
  nextCursor?: string;
  rateLimit: RateLimitState | null;
}

/** Response from `installConnector()`. */
export interface InstallConnectorResponse {
  connector: ConnectorRow;
  rateLimit: RateLimitState | null;
}

/** Response from `authenticateConnector()`. */
export interface AuthenticateConnectorResponse {
  credential_id: string;
  version: number;
  rateLimit: RateLimitState | null;
}

/** Response from `syncConnector()`. */
export interface SyncConnectorResponse {
  connector_id: string;
  status: ConnectorStatus;
  sync_started_at: string;
  rateLimit: RateLimitState | null;
}

/** Response from `revokeConnector()`. */
export interface RevokeConnectorResponse {
  connector_id: string;
  revoked_at: string;
  rateLimit: RateLimitState | null;
}

/** Response from `rotateConnectorCredentials()`. */
export interface RotateCredentialsResponse {
  connector_id: string;
  new_version: number;
  rotated_at: string;
  rateLimit: RateLimitState | null;
}

/** Response from `listEnforcementPolicies()`. */
export interface ListEnforcementPoliciesResponse {
  policies: ConnectorEnforcementPolicy[];
  total: number;
  rateLimit: RateLimitState | null;
}

/** Response from `upsertEnforcementPolicy()`. */
export interface UpsertEnforcementPolicyResponse {
  policy: ConnectorEnforcementPolicy;
  rateLimit: RateLimitState | null;
}
