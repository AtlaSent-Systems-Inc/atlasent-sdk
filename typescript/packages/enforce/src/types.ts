export interface EnforceBindings {
  orgId: string;
  actorId: string;
  actionType: string;
}

export interface VerifiedPermit {
  token: string;
  orgId: string;
  actorId: string;
  actionType: string;
  expiresAt: string;
}

export interface EvaluateResponse {
  decision: "allow" | "deny" | "hold" | "escalate";
  permit?: { token: string; expiresAt: string };
  reasonCode?: string;
}

export interface EnforceCompatibleClient {
  evaluate(request: Record<string, unknown>): Promise<EvaluateResponse>;
  verifyPermit(token: string): Promise<VerifiedPermit>;
}

export interface EnforceConfig {
  client: EnforceCompatibleClient;
  bindings: EnforceBindings;
  failClosed: true;
  latencyBudgetMs?: number;
  latencyBreachMode?: "deny" | "warn";
  onLatencyBreach?: () => void;
}

export interface EnforceRunRequest<T> {
  request: Record<string, unknown>;
  execute: (permit: VerifiedPermit) => Promise<T>;
}

export type ReasonCode =
  | "evaluate_client_error"
  | "evaluate_unavailable"
  | "verify_client_error"
  | "verify_unavailable"
  | "verify_latency_breach"
  | "binding_mismatch"
  | "permit_expired"
  | "permit_consumed"
  | "permit_revoked"
  | "permit_not_found"
  | "permit_tampered";

/**
 * Subset of ReasonCode values that align with the v1 SDK's
 * `PermitOutcome` (atlasent-sdk PR #132 / #133). When a verifyPermit
 * adapter throws an error carrying `reasonCode` set to one of these,
 * Enforce.run() surfaces it verbatim — no remapping, no string
 * massaging, byte-identical with the SDK's typed `outcome` field.
 *
 * See `contract/ENFORCE_PACK.md` § "Decision matrix" for the full
 * mapping; `atlasent/docs/REVOCATION_RUNBOOK.md` for the operator-
 * facing matrix this discriminator drives.
 */
export type PermitOutcomeReasonCode =
  | "permit_expired"
  | "permit_consumed"
  | "permit_revoked"
  | "permit_not_found";

export type EnforceRunResult<T> =
  | { decision: "allow"; value: T; permit: VerifiedPermit }
  | { decision: "deny" | "hold" | "escalate"; reasonCode: string };
