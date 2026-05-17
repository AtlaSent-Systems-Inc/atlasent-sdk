/**
 * Override types — wire shapes for `/v1/overrides`.
 *
 * Overrides allow an authorized actor to bypass a deny decision for a
 * specific evaluation. They must be approved before they take effect
 * and can be revoked at any time.
 *
 * Mirrors `api/src/schemas/overrides.ts` in atlasent-control-plane.
 */

/**
 * Lifecycle status of an override request.
 *
 * - `pending`  — created, waiting for approval
 * - `approved` — approved and active; the evaluation's deny is lifted
 * - `revoked`  — manually revoked
 * - `expired`  — TTL elapsed before revocation
 */
export type OverrideStatus = "pending" | "approved" | "revoked" | "expired";

/**
 * The event types that can appear on an override's event log.
 */
export type OverrideEventType = "created" | "approved" | "revoked";

/**
 * Canonical Override domain object returned by the API.
 *
 * All timestamps are ISO-8601 UTC strings. Nullable fields are `null`
 * rather than omitted so wire shapes are stable.
 */
export interface OverrideV1 {
  id: string;
  orgId: string;
  /** The evaluation ID this override applies to. */
  evaluationId: string;
  /** Human-readable justification provided at creation time. */
  reason: string;
  status: OverrideStatus;
  /** Actor who requested the override. */
  requestedBy: string;
  /** Actor who approved the override, or `null` if not yet approved. */
  approvedBy: string | null;
  /** Actor who revoked the override, or `null` if not revoked. */
  revokedBy: string | null;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 approval timestamp, or `null`. */
  approvedAt: string | null;
  /** ISO-8601 revocation timestamp, or `null`. */
  revokedAt: string | null;
  /** ISO-8601 expiry timestamp, or `null` if no TTL was set. */
  expiresAt: string | null;
  /** Arbitrary key/value metadata attached at creation. `null` when none. */
  metadata: Record<string, unknown> | null;
}

/**
 * Paginated list of overrides.
 */
export interface OverrideListResponse {
  items: OverrideV1[];
  /** Opaque cursor for the next page. `null` when there are no more results. */
  nextCursor: string | null;
}

/**
 * Input for `POST /v1/overrides` — request a new override.
 */
export interface CreateOverrideRequest {
  /** Human-readable justification. Required; max 2000 characters. */
  reason: string;
  /** The evaluation ID to override. */
  evaluationId: string;
  /** Lifetime in seconds. Defaults to 3600. Max 604800 (7 days). */
  ttlSeconds?: number;
  /** Arbitrary metadata to attach to the override record. */
  metadata?: Record<string, unknown>;
}

/**
 * Audit event appended to an override's event log on every state mutation.
 */
export interface OverrideEvent {
  id: string;
  overrideId: string;
  orgId: string;
  /** Actor who caused this event. */
  actorId: string;
  type: OverrideEventType;
  /** ISO-8601 timestamp. */
  at: string;
  /** Event-specific payload. `null` when none. */
  payload: Record<string, unknown> | null;
}

/**
 * Response for `GET /v1/overrides/:id/events`.
 */
export interface OverrideEventsResponse {
  items: OverrideEvent[];
}
