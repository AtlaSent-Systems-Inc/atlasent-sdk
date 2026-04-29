/**
 * `evaluateBatchPolyfilled()` — runtime polyfill for the Pillar 2
 * batch evaluate API.
 *
 * Implements the v2 `EvaluateBatchResponse` shape on top of v1's
 * per-call `evaluate()`. Customers can use the v2 batch ergonomics
 * **today**, against the v1 server; when `POST /v2/evaluate:batch`
 * ships at v2 GA, swap this for a single round trip with no
 * caller-side change.
 *
 * Trade-offs vs. the real v2 server endpoint:
 *
 *   - **N HTTP calls instead of one.** Each item is its own
 *     `evaluate()`. Use `concurrency` to cap parallelism so we
 *     don't blow through the per-key rate limit.
 *   - **N rate-limit decrements instead of one.** v2's batch
 *     amortizes; the polyfill doesn't.
 *   - **No batch-level audit-chain entry.** Each item gets its
 *     own audit_hash; we generate a synthetic `batch_id` so
 *     callers can correlate locally.
 *   - **Pillar 9 `payload_hash` opt-in is silently ignored.**
 *     v1 has no consume endpoint to bind a proof to; the polyfill
 *     drops `payload_hash` / `target` / `proof_id` / `proof_status`.
 *     Real Pillar 9 needs the v2 server.
 *
 * The polyfill is structurally typed against v1's `evaluate()`
 * method — no runtime import of `@atlasent/sdk` — so it works
 * with any client object exposing the right shape. Callers
 * typically pass `new AtlaSentClient({ apiKey })`.
 */

import { randomUUID } from "node:crypto";

import { buildEvaluateBatchRequest } from "./buildBatch.js";
import type {
  BatchEvaluateAllowItem,
  BatchEvaluateDenyItem,
  BatchEvaluateItem,
  BatchEvaluateResponseItem,
  EvaluateBatchResponse,
} from "./batch.js";

/**
 * Minimal structural type for the v1 client's `evaluate()` method.
 * Re-declared so this module doesn't take a runtime dep on
 * `@atlasent/sdk`. `AtlaSentClient` (v1) satisfies this shape.
 */
export interface BatchPolyfillClient {
  evaluate(input: {
    agent: string;
    action: string;
    context?: Record<string, unknown>;
  }): Promise<{
    decision: "ALLOW" | "DENY";
    permitId: string;
    reason: string;
    auditHash: string;
    timestamp: string;
  }>;
}

/** Options for {@link evaluateBatchPolyfilled}. */
export interface EvaluateBatchPolyfillOptions {
  /**
   * Maximum number of `evaluate()` calls in flight at once.
   * Defaults to 10 — small enough to leave headroom for other
   * traffic on the same key, large enough to amortize for typical
   * batch sizes. Set to `Infinity` to disable.
   */
  concurrency?: number;
  /**
   * Override the synthetic `batch_id`. Useful for tests; defaults
   * to a fresh UUID per call. Production callers should leave this
   * unset so each batch gets a unique correlation id.
   */
  batchId?: string;
}

/**
 * Run a Pillar 2 batch via the v1 client.
 *
 * Validates `items` via {@link buildEvaluateBatchRequest} (size +
 * shape), runs every item's `evaluate()` in parallel with an
 * optional concurrency cap, and stitches the results into a
 * v2-shaped {@link EvaluateBatchResponse}.
 *
 * Order is preserved: `result.items[i]` decides `items[i]`.
 *
 * Throws if any underlying `evaluate()` rejects (transport / auth
 * / rate-limit failures). v1 returns clean denials as
 * `decision: "DENY"` data — those become per-item
 * `permitted: false`, not throws.
 *
 * @example
 *   const client = new AtlaSentClient({ apiKey });
 *   const batch = await evaluateBatchPolyfilled(client, [
 *     { action: "modify_record", agent: "agent-1", context: { id: "PT-001" } },
 *     { action: "modify_record", agent: "agent-1", context: { id: "PT-002" } },
 *   ]);
 *   for (const item of batch.items) {
 *     if (item.permitted) log(item.decision_id);
 *     else log(`denied: ${item.reason}`);
 *   }
 */
export async function evaluateBatchPolyfilled(
  client: BatchPolyfillClient,
  items: readonly BatchEvaluateItem[],
  options: EvaluateBatchPolyfillOptions = {},
): Promise<EvaluateBatchResponse> {
  // Validate via the v2 builder so size + shape errors fire the
  // same way they would against the real v2 server.
  buildEvaluateBatchRequest(items, "polyfill_validation_only");

  const batchId = options.batchId ?? randomUUID();
  const concurrency = options.concurrency ?? 10;
  if (concurrency < 1) {
    throw new Error(
      `evaluateBatchPolyfilled: concurrency must be >= 1, got ${concurrency}`,
    );
  }

  const responseItems = await mapWithConcurrency(
    items,
    concurrency,
    async (item, index) => toBatchResponseItem(client, item, index, batchId),
  );

  return {
    batch_id: batchId,
    items: responseItems,
  };
}

// ─── Internals ────────────────────────────────────────────────────────

async function toBatchResponseItem(
  client: BatchPolyfillClient,
  item: BatchEvaluateItem,
  index: number,
  batchId: string,
): Promise<BatchEvaluateResponseItem> {
  const result = await client.evaluate({
    agent: item.agent,
    action: item.action,
    context: item.context,
  });

  const common = {
    index,
    decision_id: result.permitId,
    reason: result.reason,
    audit_hash: result.auditHash,
    timestamp: result.timestamp,
    batch_id: batchId,
  };

  if (result.decision === "ALLOW") {
    const allow: BatchEvaluateAllowItem = {
      ...common,
      permitted: true,
    };
    return allow;
  }
  const deny: BatchEvaluateDenyItem = {
    ...common,
    permitted: false,
  };
  return deny;
}

/**
 * Run `fn` against every item with a max-in-flight cap. Preserves
 * input order in the output. Errors propagate to the caller —
 * unlike `Promise.allSettled`, we surface the first failure.
 *
 * The cap matters: a 1000-item batch with no cap fan-outs 1000
 * concurrent fetches, exhausting the per-key rate limit and risking
 * a 429 stampede. Default cap (10) is conservative.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency >= items.length) {
    // Fast path — map directly.
    return Promise.all(items.map((item, i) => fn(item, i)));
  }
  const out: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w += 1) {
    workers.push(
      (async () => {
        // Each worker grabs the next index until the queue drains.
        while (true) {
          const i = nextIndex;
          nextIndex += 1;
          if (i >= items.length) return;
          out[i] = await fn(items[i] as T, i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}
