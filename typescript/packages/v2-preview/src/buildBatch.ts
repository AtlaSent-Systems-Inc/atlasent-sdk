/**
 * Pure-data builders for the Pillar 2 batch wire surface.
 *
 * No HTTP. The v2-preview package is deliberately HTTP-free; these
 * helpers construct the canonical request body and validate inbound
 * response bodies so callers wiring their own `fetch` / `httpx`
 * client can rely on consistent shape checking. The eventual v2 SDK
 * client wraps these.
 *
 * Validation goals:
 *
 *   - Reject input that violates the schema's hard constraints
 *     (`requests.minItems`, `maxItems`, required-fields).
 *   - Forward unknown fields verbatim — the schemas allow optional
 *     additions, and silent drop would surprise non-SDK adopters
 *     reading these helpers as a reference implementation.
 */

import {
  EVALUATE_BATCH_MAX_ITEMS,
  type BatchEvaluateItem,
  type BatchEvaluateResponseItem,
  type EvaluateBatchRequest,
  type EvaluateBatchResponse,
} from "./batch.js";

/**
 * Construct a wire-valid `EvaluateBatchRequest` from per-item input
 * and an API key.
 *
 * Validates:
 *   - `items.length` ∈ [1, 1000]
 *   - Each item has non-empty `action`, `agent`
 *   - `payload_hash`, when present, is 64 hex chars (matches schema regex)
 *   - `api_key` is a non-empty string
 *
 * Throws {@link Error} on any violation. Catches them at the SDK
 * boundary so the network layer never sends an obviously malformed
 * batch.
 */
export function buildEvaluateBatchRequest(
  items: readonly BatchEvaluateItem[],
  apiKey: string,
): EvaluateBatchRequest {
  if (items.length === 0) {
    throw new Error("buildEvaluateBatchRequest: requests must contain at least 1 item");
  }
  if (items.length > EVALUATE_BATCH_MAX_ITEMS) {
    throw new Error(
      `buildEvaluateBatchRequest: requests exceeds max ${EVALUATE_BATCH_MAX_ITEMS} (got ${items.length})`,
    );
  }
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("buildEvaluateBatchRequest: api_key must be a non-empty string");
  }

  const cleaned: BatchEvaluateItem[] = items.map((item, i) => {
    if (typeof item.action !== "string" || item.action.length === 0) {
      throw new Error(`buildEvaluateBatchRequest: items[${i}].action must be non-empty`);
    }
    if (typeof item.agent !== "string" || item.agent.length === 0) {
      throw new Error(`buildEvaluateBatchRequest: items[${i}].agent must be non-empty`);
    }
    if (item.payload_hash !== undefined && !/^[0-9a-f]{64}$/.test(item.payload_hash)) {
      throw new Error(
        `buildEvaluateBatchRequest: items[${i}].payload_hash must be 64 lowercase hex chars`,
      );
    }
    // Preserve item shape verbatim — including any forward-compat
    // fields the caller passed that we don't know about. The schema
    // permits additionalProperties at the item level.
    const out: BatchEvaluateItem = {
      action: item.action,
      agent: item.agent,
      context: item.context ?? {},
    };
    if (item.payload_hash !== undefined) out.payload_hash = item.payload_hash;
    if (item.target !== undefined) out.target = item.target;
    // Forward any extra fields untouched.
    const outRec = out as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(item)) {
      if (!(k in outRec)) outRec[k] = v;
    }
    return out;
  });

  return { requests: cleaned, api_key: apiKey };
}

/**
 * Validate + narrow a server response body into a typed
 * {@link EvaluateBatchResponse}. Lifts the per-item discriminated
 * union into the type system so callers can branch on `item.permitted`
 * without unsafe casts.
 *
 * Throws {@link Error} on structural violations (missing top-level
 * fields, items that aren't objects, `permitted` not a boolean).
 * Returns the parsed response unchanged otherwise — including any
 * forward-compat fields the server emitted.
 */
export function parseEvaluateBatchResponse(body: unknown): EvaluateBatchResponse {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("parseEvaluateBatchResponse: body must be a JSON object");
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.batch_id !== "string" || obj.batch_id.length === 0) {
    throw new Error("parseEvaluateBatchResponse: missing or non-string `batch_id`");
  }
  if (!Array.isArray(obj.items)) {
    throw new Error("parseEvaluateBatchResponse: `items` must be an array");
  }
  const items: BatchEvaluateResponseItem[] = obj.items.map((it, i) => {
    if (it === null || typeof it !== "object" || Array.isArray(it)) {
      throw new Error(`parseEvaluateBatchResponse: items[${i}] must be a JSON object`);
    }
    const item = it as Record<string, unknown>;
    if (typeof item.permitted !== "boolean") {
      throw new Error(
        `parseEvaluateBatchResponse: items[${i}].permitted must be a boolean`,
      );
    }
    if (typeof item.decision_id !== "string") {
      throw new Error(
        `parseEvaluateBatchResponse: items[${i}].decision_id must be a string`,
      );
    }
    return item as unknown as BatchEvaluateResponseItem;
  });
  return { batch_id: obj.batch_id, items };
}
