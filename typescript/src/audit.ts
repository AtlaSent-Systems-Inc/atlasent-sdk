/**
 * Shared audit wire types — the `/v1/audit/*` HTTP surface.
 *
 * Source of truth: `atlasent-api/supabase/functions/v1-audit/index.ts`
 * (the edge function that serves `GET /v1/audit/events`,
 * `POST /v1/audit/exports`, and `POST /v1/audit/verify`). The docstring
 * at the top of that file describes these shapes. Keep this module in
 * lockstep with it; `test/audit-types.test.ts` contains type-level
 * assertions against the field set to make drift obvious.
 *
 * Fields are snake_case because that is what the server emits on the
 * wire — unlike the evaluate / verify-permit types in `./types.ts`,
 * which use camelCase on the SDK side and translate at the client
 * boundary, the audit surface is intentionally wire-identical so that
 * signed export bundles round-trip byte-for-byte through verifiers.
 */

/** Policy decision enum used on `audit_events.decision`. */
export type AuditDecision = 'allow' | 'deny' | 'hold' | 'escalate';

/**
 * Signing status reported on an export bundle. "signed" is the normal
 * path; "unsigned" means the deployment has no active signing key;
 * "signing_failed" means a key is configured but signing errored and
 * the export was returned anyway (the signature is an empty string).
 */
export type AuditExportSignatureStatus =
  | 'signed'
  | 'unsigned'
  | 'signing_failed';

/**
 * One persisted row from `audit_events`, as returned by
 * `GET /v1/audit/events` and embedded inside `AuditExport.events`.
 *
 * `decision` is nullable because not every event is an evaluation —
 * CRUD-style audit writes (e.g. `policy.updated`) omit it. All other
 * nullable fields follow the same "field doesn't apply to this event
 * type" convention rather than "unknown value".
 */
export interface AuditEvent {
  /** Event UUID. Stable; surfaces as `tampered_event_ids` on verify failure. */
  id: string;
  /** Organization this event belongs to. */
  org_id: string;
  /** Per-org monotonic sequence. Used as the pagination cursor's payload. */
  sequence: number;
  /** Event type tag (e.g. "evaluate.allow", "policy.updated"). */
  type: string;
  /** Policy decision when the event is an evaluation; `null` otherwise. */
  decision: AuditDecision | null;
  /** Actor id (user / API key / agent) when applicable. */
  actor_id: string | null;
  /** Optional resource tag — e.g. "policy". */
  resource_type: string | null;
  /** Optional resource id — paired with `resource_type`. */
  resource_id: string | null;
  /** Canonical JSON of the event payload. Hashed into `hash`. */
  payload: Record<string, unknown> | null;
  /** SHA-256(prev_hash || canonicalJSON(payload)), hex. */
  hash: string;
  /** Previous event's `hash` (genesis is `"0".repeat(64)`). */
  previous_hash: string;
  /** When the underlying action occurred (ISO 8601). */
  occurred_at: string;
  /** When the row was persisted (ISO 8601). */
  created_at: string;
}

/**
 * Response shape for `GET /v1/audit/events`.
 *
 * `total` is the filter's full count (not just this page) so callers
 * can show "page 1 of N" without an extra HEAD request.
 *
 * `next_cursor` is an opaque base64url string. Pass it back verbatim
 * as `?cursor=...` to fetch the next page. Absent when this is the
 * last page.
 */
export interface AuditEventsPage {
  events: AuditEvent[];
  total: number;
  next_cursor?: string;
}

/**
 * Query parameters accepted by `GET /v1/audit/events`. Serialize as
 * URL search params — `types` is a comma-joined list on the wire
 * (e.g. `types=evaluate.allow,policy.updated`).
 *
 * All fields are optional; the server defaults `limit` to 50 and caps
 * it at 500.
 */
export interface AuditEventsQuery {
  /** Comma-joined list of event types to filter on. */
  types?: string;
  /** Filter to a single actor. */
  actor_id?: string;
  /** Inclusive lower bound on `occurred_at` (ISO 8601). */
  from?: string;
  /** Inclusive upper bound on `occurred_at` (ISO 8601). */
  to?: string;
  /** Page size. Default 50, min 1, max 500. */
  limit?: number;
  /** Opaque cursor returned as `next_cursor` by the prior page. */
  cursor?: string;
}

/**
 * Response shape for `POST /v1/audit/exports` — a signed bundle of
 * audit events suitable for offline verification.
 *
 * `signature` is detached Ed25519 over `signedBytesFor(bundle)` (see
 * `./auditBundle.ts`). An empty string means the server attempted to
 * sign but failed; check `signature_status` to distinguish.
 *
 * `tampered_event_ids` surfaces rows whose recomputed hash doesn't
 * match the stored hash — even when `chain_integrity_ok` is false,
 * the signature still covers whatever the server emitted, so callers
 * that trust the signature must still inspect this list.
 */
export interface AuditExport {
  /** Server-assigned UUID for this export. */
  export_id: string;
  /** Organization the bundle belongs to. */
  org_id: string;
  /** Events in canonical (ascending sequence) order. */
  events: AuditEvent[];
  /** Last event's `hash`, or `"0".repeat(64)` if `events` is empty. */
  chain_head_hash: string;
  /** `true` iff adjacency + re-hash succeeded for every event. */
  chain_integrity_ok: boolean;
  /** `AuditEvent.id`s whose recomputed hash != stored hash. */
  tampered_event_ids: string[];
  /** Detached Ed25519 signature (base64url). Empty string on sign failure. */
  signature: string;
  /** Outcome of the signing attempt. */
  signature_status: AuditExportSignatureStatus;
  /** Registry id of the key that signed — absent when unsigned. */
  signing_key_id?: string;
  /** When the bundle was signed (ISO 8601). */
  signed_at: string;
}
