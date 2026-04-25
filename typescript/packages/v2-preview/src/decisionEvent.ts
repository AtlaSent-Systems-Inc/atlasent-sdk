/**
 * v2 Pillar 3 — Decision-event types.
 *
 * Structural mirror of `contract/schemas/v2/decision-event.schema.json`.
 * Each event the server emits on `GET /v2/decisions:subscribe` is
 * one of the seven types below; the `type` field discriminates the
 * union and TypeScript narrows automatically:
 *
 * ```ts
 * for await (const ev of parseDecisionEventStream(response.body!)) {
 *   if (ev.type === "consumed") {
 *     // ev.payload typed as ConsumedPayload here
 *   }
 * }
 * ```
 *
 * Forward compatibility: the schema's per-event `payload` is
 * `additionalProperties: true`, so unknown fields on a known event
 * type pass through. {@link UnknownDecisionEvent} catches event
 * types the SDK doesn't recognize at all so future server emissions
 * don't crash older clients.
 */

import type { ConsumeExecutionStatus, ProofDecision } from "./types.js";

/** Common fields every DecisionEvent carries. */
export interface DecisionEventCommon {
  /** Monotonic per-org event id. SSE `Last-Event-ID` resume token. */
  id: string;
  /** Organization the event belongs to. */
  org_id: string;
  /** ISO 8601 timestamp the event was emitted by the server. */
  emitted_at: string;
  /** Decision id this event relates to. Absent on `rate_limit_state`. */
  permit_id?: string;
  /** Actor that triggered the event. `null` for system-triggered. */
  actor_id?: string | null;
}

export interface PermitIssuedPayload {
  decision: ProofDecision;
  agent: string;
  action: string;
  audit_hash: string;
  reason?: string;
}

export interface VerifiedPayload {
  permit_hash: string;
  outcome: string;
}

export interface ConsumedPayload {
  proof_id: string;
  execution_status: ConsumeExecutionStatus;
  audit_hash: string;
}

export interface RevokedPayload {
  reason: string;
  /** `null` when the system auto-revoked on TTL. */
  revoker_id: string | null;
}

export interface EscalatedPayload {
  /** Escalation queue / approver group identifier. */
  to: string;
  reason: string;
}

export interface HoldResolvedPayload {
  resolution: "approved" | "denied" | "expired";
  resolved_by: string | null;
}

export interface RateLimitStatePayload {
  limit: number;
  remaining: number;
  /** Either unix-seconds integer or ISO 8601 string — same dual form as v1's `X-RateLimit-Reset`. */
  reset_at: number | string;
}

export interface PermitIssuedEvent extends DecisionEventCommon {
  type: "permit_issued";
  payload: PermitIssuedPayload;
}

export interface VerifiedEvent extends DecisionEventCommon {
  type: "verified";
  payload: VerifiedPayload;
}

export interface ConsumedEvent extends DecisionEventCommon {
  type: "consumed";
  payload: ConsumedPayload;
}

export interface RevokedEvent extends DecisionEventCommon {
  type: "revoked";
  payload: RevokedPayload;
}

export interface EscalatedEvent extends DecisionEventCommon {
  type: "escalated";
  payload: EscalatedPayload;
}

export interface HoldResolvedEvent extends DecisionEventCommon {
  type: "hold_resolved";
  payload: HoldResolvedPayload;
}

export interface RateLimitStateEvent extends DecisionEventCommon {
  type: "rate_limit_state";
  payload: RateLimitStatePayload;
}

/**
 * Server emitted an event type this SDK doesn't recognize. Surface
 * the raw payload as opaque data rather than dropping the event —
 * lets callers log / forward unknown lifecycle states without an
 * SDK upgrade.
 */
export interface UnknownDecisionEvent extends DecisionEventCommon {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Discriminated union of every DecisionEvent the server may emit.
 * `type === "..."` narrows the payload automatically.
 */
export type DecisionEvent =
  | PermitIssuedEvent
  | VerifiedEvent
  | ConsumedEvent
  | RevokedEvent
  | EscalatedEvent
  | HoldResolvedEvent
  | RateLimitStateEvent
  | UnknownDecisionEvent;

/** Set of event types the SDK has typed payloads for. */
export const KNOWN_DECISION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "permit_issued",
  "verified",
  "consumed",
  "revoked",
  "escalated",
  "hold_resolved",
  "rate_limit_state",
]);
