/**
 * SHA-256 hex of the canonical JSON of an arbitrary value.
 *
 * The primary use case is the Pillar 9 `payload_hash` — the hash the
 * SDK computes client-side so the raw payload never crosses the wire.
 * Matches the server-side computation for any object that would round
 * through `canonicalizePayload`.
 *
 * Sync (not async) because Node 20+ ships a synchronous SHA-256 via
 * `crypto.createHash('sha256')` with no extra dependency. Accepting
 * only values that can canonicalize keeps the signature honest —
 * functions, symbols, etc. flow through `canonicalizePayload` as
 * `"null"`, consistent with the rest of the canonicalization rules.
 *
 * @see `contract/schemas/v2/consume-request.schema.json` — payload_hash
 * @see `contract/schemas/v2/proof.schema.json` — payload_hash
 */
import { createHash } from "node:crypto";

import { canonicalizePayload } from "./canonicalize.js";

export function hashPayload(value: unknown): string {
  const canonical = canonicalizePayload(value);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
