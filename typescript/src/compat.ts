/**
 * Dual-shape input bridge for the v2.0.0 wire format change.
 *
 * The v2.0.0 wire format renamed the evaluate request fields:
 *   OLD (legacy alias): { action, agent, context, api_key }
 *   NEW (canonical):    { action_type, actor_id, context }
 *
 * And the response fields:
 *   OLD: { permitted, decision_id }
 *   NEW: { decision, permit_token }
 *
 * The canonical `action_type` / `actor_id` names match the runtime
 * `/v1-evaluate` wire format (see
 * `contract/schemas/evaluate-request.schema.json`). TypeScript callers on
 * the legacy `action` / `agent` shape receive a deprecation warning and are
 * transparently upgraded to the canonical shape — resolution is per-field,
 * so a mixed shape (e.g. `{ actor_id, action }`) is handled correctly. The
 * response compat bridge normalises the legacy `permitted` boolean to
 * `decision === "allow"`.
 *
 * Both shims will be removed in a future major release.
 */

/** Legacy v1.x evaluate request shape (deprecated field names). */
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
  /** Populate `risk_envelope.factors` in the response (Phase C). */
  explain?: boolean;
  /** Deployment environment where the action executes (e.g. `"production"`). */
  environment?: string;
  /** Structured resource descriptor. Prefer over `resource_id` for new callers. */
  resource?: { type: string; id?: string; attributes?: Record<string, unknown> };
  /** Snapshot of the resource before the proposed action. Enables state-transition-aware policy evaluation. */
  current_state?: { description: string; attributes?: Record<string, unknown> };
  /** Desired resource state after the action. */
  proposed_state?: { description: string; attributes?: Record<string, unknown> };
  /** Execution surface binding (CI/CD adapter, DB driver, etc.). */
  execution_binding?: { kind: string; adapter_version?: string; resource_id?: string; enforcement_point?: string };
  /**
   * State snapshot of the system at evaluation time. Required when the action
   * class has `requires_state_snapshot = true`. Omitting causes a
   * `SNAPSHOT_REQUIRED` deny on affected action classes.
   */
  state_snapshot?: {
    source?: string;
    source_kind?: 'trusted' | 'untrusted';
    complete?: boolean;
    payload?: Record<string, unknown>;
  };
}

const _LEGACY_EVALUATE_FIELDS_WARNING =
  '[atlasent] Deprecation: the action/agent evaluate request fields are ' +
  'deprecated. Use action_type/actor_id instead (the canonical wire names). ' +
  'The legacy aliases are still accepted and will be removed in a future ' +
  'major release.';

/**
 * Resolve the canonical `action_type` / `actor_id` identity from an evaluate
 * request that may carry the canonical fields, the legacy `action` / `agent`
 * aliases, or a mix of both. Canonical fields win per-field; a legacy field is
 * only consulted when its canonical counterpart is absent.
 *
 * When any legacy alias is actually used a single `console.warn` deprecation
 * notice is emitted. Returns whichever values are present (possibly
 * `undefined` if the caller supplied neither) — callers/servers still enforce
 * that both are present.
 */
export function resolveEvaluateIdentity(
  input: LegacyEvaluateRequest | V2EvaluateRequest,
): { action_type: string | undefined; actor_id: string | undefined } {
  const src = input as Partial<V2EvaluateRequest> & Partial<LegacyEvaluateRequest>;
  const usedLegacyAction = src.action_type == null && src.action != null;
  const usedLegacyAgent = src.actor_id == null && src.agent != null;
  if (usedLegacyAction || usedLegacyAgent) {
    // eslint-disable-next-line no-console
    console.warn(_LEGACY_EVALUATE_FIELDS_WARNING);
  }
  return {
    action_type: src.action_type ?? src.action,
    actor_id: src.actor_id ?? src.agent,
  };
}

/**
 * Normalise an evaluate request from either the legacy v1.x shape
 * (`action` / `agent`) or the canonical shape (`action_type` / `actor_id`)
 * into the canonical wire format. Resolution is per-field, so a mixed shape
 * is handled correctly.
 *
 * When any legacy alias is used a `console.warn` deprecation notice is
 * emitted. A request already in the pure canonical shape (no `action` /
 * `agent` keys) is returned unchanged (referential identity preserved). The
 * shim will be removed in a future major release.
 */
export function normalizeEvaluateRequest(
  input: LegacyEvaluateRequest | V2EvaluateRequest,
): V2EvaluateRequest {
  const hasLegacyField =
    ('action' in input && (input as V2EvaluateRequest).action_type == null) ||
    ('agent' in input && (input as V2EvaluateRequest).actor_id == null);

  // Pure canonical (or nothing legacy to map): pass through unchanged.
  if (!hasLegacyField) {
    return input as V2EvaluateRequest;
  }

  const { action_type, actor_id } = resolveEvaluateIdentity(input);
  const src = input as Partial<V2EvaluateRequest> & Partial<LegacyEvaluateRequest>;
  const normalized: V2EvaluateRequest = {
    action_type: action_type as string,
    actor_id: actor_id as string,
  };
  if (src.context !== undefined) normalized.context = src.context;
  if (src.explain !== undefined) normalized.explain = src.explain;
  if (src.environment !== undefined) normalized.environment = src.environment;
  if (src.resource !== undefined) normalized.resource = src.resource;
  if (src.current_state !== undefined) normalized.current_state = src.current_state;
  if (src.proposed_state !== undefined) normalized.proposed_state = src.proposed_state;
  if (src.execution_binding !== undefined) normalized.execution_binding = src.execution_binding;
  if (src.state_snapshot !== undefined) normalized.state_snapshot = src.state_snapshot;
  return normalized;
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
