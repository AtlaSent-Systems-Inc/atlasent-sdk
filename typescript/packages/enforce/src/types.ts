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
  | "permit_tampered";

export type EnforceRunResult<T> =
  | { decision: "allow"; value: T; permit: VerifiedPermit }
  | { decision: "deny"; reasonCode: string };
