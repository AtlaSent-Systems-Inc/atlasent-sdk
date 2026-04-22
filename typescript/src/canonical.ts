/**
 * Deterministic JSON canonicalization + SHA-256 helpers.
 *
 * Must stay byte-for-byte in lock-step with the server-side signer
 * and the Python SDK's `canonicalize` (`python/atlasent/canonical.py`).
 * Any divergence produces non-reproducible signatures, so this module
 * is dependency-free and intentionally small.
 *
 * Rules (RFC 8785 JCS for the cases we care about):
 *   - object keys are sorted lexicographically at every depth
 *   - no whitespace
 *   - `undefined` normalizes to the literal `"null"` at every level so
 *     output is always valid JSON (matches the server's verifier)
 *   - in an object, a `null` value is emitted as `null`; in an array a
 *     `null` element is likewise preserved
 *   - strings use `JSON.stringify` escaping (UTF-8 passes through)
 */

import { createHash } from "node:crypto";

/**
 * Return the canonical JSON string for `value`. The output matches
 * the bytes the AtlaSent audit-export signer feeds into Ed25519, so
 * `sign(canonicalize(envelope - signature))` reproduces the
 * `signature` field of the export envelope.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return (
      "[" +
      value
        .map((v) => (v === undefined ? "null" : canonicalize(v)))
        .join(",") +
      "]"
    );
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ":" + canonicalize(v));
  }
  return "{" + parts.join(",") + "}";
}

/** SHA-256 hex digest of a UTF-8 string or byte array. */
export function sha256Hex(input: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof input === "string") hash.update(input, "utf8");
  else hash.update(input);
  return hash.digest("hex");
}
