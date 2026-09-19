/**
 * Execution-payload digests, in the two forms the runtime actually binds.
 *
 * There are TWO of them and they are NOT interchangeable. `v1-verify-permit`
 * compares the digest a caller presents against whichever one the permit was
 * bound to at evaluate time, with no normalization on either side
 * (`handler.ts`, the `callerPayloadHash.toLowerCase() !== boundPayloadHash
 * .toLowerCase()` branch — case is folded, nothing else is), so presenting the
 * wrong FORM of the right digest is a deterministic `PAYLOAD_MISMATCH`:
 *
 * 1. **Caller-supplied binding — BARE lowercase 64-hex, no prefix.** When an
 *    evaluate request carries a top-level `execution_payload_hash` matching
 *    `/^[0-9a-f]{64}$/i`, `v1-evaluate` lowercases it and signs it into the
 *    permit as `execution_hash_expected`. This is the binding that means
 *    something: the caller chose what to digest, so re-deriving it at the
 *    execution boundary detects a payload that changed after authorization.
 *    A `sha256:`-prefixed value fails that regex and is DROPPED, not rejected
 *    — allow, permit, 200, no error. `normalizeExecutionPayloadHash` in
 *    `protect.ts` exists so that cannot happen silently; it is deliberately
 *    the ONLY normalizer, not one of two.
 *
 * 2. **Server fallback binding — `sha256:` + 64-hex.** With no caller digest,
 *    the permit is bound to the server's own hash of the whole evaluate
 *    request body (`v1-evaluate`'s `proofPayloadHash`, via
 *    `_shared/canonical.ts`'s `hashPayload`, which PREFIXES the scheme).
 *    {@link serverPayloadHash} reproduces it.
 *
 * Form 2 is what {@link canonicalizePayload} + {@link serverPayloadHash} are
 * for, and getting its prefix wrong is not hypothetical: every `protect()`
 * call presented a bare-hex mirror of the server's prefixed hash, so the two
 * could never compare equal. The digest MATERIAL was correct — verified
 * byte-identical across unicode, escapes, `undefined`, numeric and
 * key-ordering vectors (see `test/payload-hash-parity.test.ts`) — and the
 * scheme prefix alone denied the permit.
 *
 * `canonicalizePayload` must stay byte-identical to `_shared/canonical.ts`'s
 * `canonicalize` (whose own header says the same thing from the other side:
 * "Must stay in lock-step with the SDK and the standalone verifier"). The
 * parity test holds both halves: a vendored reference copy of the server
 * function AND committed golden digests, so neither side can be "fixed" into
 * agreement with a broken counterpart.
 */

/**
 * Deterministic JSON canonicalization: object keys sorted at every depth, no
 * whitespace, `JSON.stringify` escaping.
 *
 * Byte-identical port of `atlasent-api`
 * `supabase/functions/_shared/canonical.ts::canonicalize`. Do not "improve"
 * it — any change to the emitted bytes changes every digest computed from it,
 * on both sides, and the parity test will fail (which is the point).
 */
export function canonicalizePayload(value: unknown): string {
  // `JSON.stringify(undefined)` returns undefined, not a string, which would
  // produce invalid JSON like "[,]" in arrays. Normalize to null up front so
  // the output is always a valid JSON string.
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return (
      "[" +
      value
        .map((v) => (v === undefined ? "null" : canonicalizePayload(v)))
        .join(",") +
      "]"
    );
  }
  const entries: string[] = [];
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    // Object-valued undefined is skipped (matches JSON.stringify for
    // non-array objects). Array-valued undefined became null above.
    if (v === undefined) continue;
    entries.push(JSON.stringify(k) + ":" + canonicalizePayload(v));
  }
  return "{" + entries.join(",") + "}";
}

/** SHA-256 hex of `input`, via Web Crypto with a `node:crypto` fallback. */
async function sha256Hex(input: string): Promise<string> {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle?.digest) {
    const bytes = new TextEncoder().encode(input);
    const buf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Node < 20, or a runtime without the Web Crypto global. Dynamic import so
  // browser-targeting bundlers don't pull in node internals; the `node:`
  // prefix defeats any user-land shim.
  const { createHash } = await import(
    /* @vite-ignore */ /* webpackIgnore: true */ "node:crypto"
  );
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** `true` when `value` is a bare 64-char hex digest (case-insensitive). */
export function isBarePayloadHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

/**
 * Reproduce the server's fallback binding: `"sha256:" + hex` over the
 * canonical form of the evaluate request body.
 *
 * The `sha256:` prefix is part of the value, not decoration — `_shared/
 * canonical.ts::hashPayload` adds it, `v1-evaluate` persists the result to
 * `execution_evaluations.payload_hash` and signs it into the permit, and
 * `v1-verify-permit` compares the presented digest against it verbatim.
 * Returning bare hex here is the exact defect this module documents.
 *
 * @param payload The evaluate request body as sent on the wire, minus the
 *   three fields the server strips before hashing (`traceparent`, `shadow`,
 *   `explain`). A body that carries a field this caller did not include
 *   yields a different hash on the server, so callers that reconstruct the
 *   body must reconstruct it exactly.
 */
export async function serverPayloadHash(payload: unknown): Promise<string> {
  return "sha256:" + (await sha256Hex(canonicalizePayload(payload)));
}
