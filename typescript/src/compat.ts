/**
 * Dual-shape input bridge for the v2.0.0 wire format change.
 *
 * The v2.0.0 wire format renamed the evaluate request fields:
 *   OLD: { action, agent, context, api_key }
 *   NEW: { action_type, actor_id, context }
 *
 * And the response fields:
 *   OLD: { permitted, decision_id }
 *   NEW: { decision, permit_token }
 *
 * TypeScript callers on the old v1.x request shape receive a
 * deprecation warning and are transparently upgraded to the new
 * shape. The response compat bridge normalises the legacy
 * `permitted` boolean to `decision === "allow"`.
 *
 * Both shims will be removed in v3.0.0.
 */

/** Legacy v1.x evaluate request shape. */
export interface LegacyEvaluateRequest {
  action?: string;
  agent?: string;
  context?: Record<string, unknown>;
}

/** v2.0 evaluate request shape (canonical wire format). */
export interface V2EvaluateRequest {
  action_type: string;
  actor_id: string;
  context?: Record<string, unknown>;
}

/**
 * Normalise an evaluate request from either the legacy v1.x shape
 * (`action` / `agent`) or the current v2.0 shape (`action_type` /
 * `actor_id`) into the canonical v2.0 wire format.
 *
 * When the legacy shape is detected a `console.warn` deprecation
 * notice is emitted once per call-site process lifetime. The shim
 * will be removed in v3.0.0.
 */
export function normalizeEvaluateRequest(
  input: LegacyEvaluateRequest | V2EvaluateRequest,
): V2EvaluateRequest {
  // Detect legacy shape: has `action` or `agent` but NOT `action_type` /
  // `actor_id`. Both old fields are optional in the legacy interface so
  // we key on the absence of the new fields.
  if ('action' in input && !('action_type' in input)) {
    // eslint-disable-next-line no-console
    console.warn(
      '[atlasent] Deprecation: action/agent request shape is deprecated. ' +
        'Use action_type/actor_id instead. This compatibility shim will be removed in v3.0.0.',
    );
    const legacy = input as LegacyEvaluateRequest;
    const normalized: V2EvaluateRequest = {
      action_type: legacy.action!,
      actor_id: legacy.agent!,
    };
    if (legacy.context !== undefined) {
      normalized.context = legacy.context;
    }
    return normalized;
  }
  return input as V2EvaluateRequest;
}

/**
 * Legacy v1.x evaluate response shape returned by older server
 * deployments.
 */
export interface LegacyEvaluateResponse {
  permitted?: boolean;
  decision_id?: string;
  reason?: string;
  audit_hash?: string;
  timestamp?: string;
}

/** v2.0 evaluate response shape (canonical wire format). */
export interface V2EvaluateResponse {
  decision: 'allow' | 'deny' | 'hold' | 'escalate';
  permit_token?: string;
  request_id?: string;
  expires_at?: string;
  denial?: { reason?: string; code?: string };
}

/**
 * Normalise an evaluate response from either the legacy v1.x shape
 * (`permitted` / `decision_id`) or the current v2.0 shape
 * (`decision` / `permit_token`) into the canonical v2.0 wire format.
 *
 * Used internally by the client to tolerate older atlasent-api
 * deployments without surfacing the impedance mismatch to callers.
 */
export function normalizeEvaluateResponse(
  wire: LegacyEvaluateResponse | V2EvaluateResponse,
): V2EvaluateResponse {
  if (!('decision' in wire) && 'permitted' in wire) {
    // Legacy server — map `permitted` boolean → canonical `decision`.
    const legacy = wire as LegacyEvaluateResponse;
    const normalized: V2EvaluateResponse = {
      decision: legacy.permitted ? 'allow' : 'deny',
    };
    if (legacy.decision_id !== undefined) {
      normalized.permit_token = legacy.decision_id;
    }
    if (!legacy.permitted && legacy.reason) {
      normalized.denial = { reason: legacy.reason };
    }
    return normalized;
  }
  return wire as V2EvaluateResponse;
}
