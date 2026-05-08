/**
 * Webhook signature verification for AtlaSent.
 *
 * AtlaSent signs webhook payloads with HMAC-SHA256 using your webhook secret.
 * The signature is sent in the `X-AtlaSent-Signature` header as `sha256=<hex>`.
 *
 * Usage:
 * ```ts
 * import { verifyWebhook, assertWebhook, WebhookVerificationError } from "@atlasent/sdk";
 *
 * // Returns true/false — good for middleware that needs to continue on failure
 * const valid = verifyWebhook(rawBody, req.headers["x-atlasent-signature"], secret);
 *
 * // Throws WebhookVerificationError on failure — good for middleware that throws
 * assertWebhook(rawBody, req.headers["x-atlasent-signature"], secret);
 * ```
 */

/**
 * Thrown by {@link assertWebhook} when the signature is missing,
 * malformed, or does not match the payload.
 */
export class WebhookVerificationError extends Error {
  override name = "WebhookVerificationError";

  constructor(message: string) {
    super(message);
  }
}

// ── Environment detection ─────────────────────────────────────────────────────

/**
 * True when the Web Crypto API (`crypto.subtle`) is available.
 * This is the case in browsers, Cloudflare Workers, Deno, and Node ≥ 20
 * with the global `crypto` exposed. We also accept Node's
 * `require('node:crypto').webcrypto` shape, which exposes `subtle` at the
 * same path when running under Node 18/19.
 *
 * Evaluated once at module load to avoid per-call overhead.
 */
const _hasWebCrypto: boolean = (() => {
  try {
    return (
      typeof crypto !== "undefined" &&
      typeof (crypto as { subtle?: unknown }).subtle === "object" &&
      (crypto as { subtle?: unknown }).subtle !== null
    );
  } catch {
    return false;
  }
})();

// ── Hex helpers ───────────────────────────────────────────────────────────────

/**
 * Extract the raw hex digest from a `sha256=<hex>` or bare `<hex>` signature
 * string. Returns `null` for any value that doesn't look like a valid
 * lowercase hex string of the expected length (64 chars = 32 bytes = SHA-256).
 */
function _extractHex(signature: string): string | null {
  if (typeof signature !== "string") return null;

  const hex = signature.startsWith("sha256=") ? signature.slice(7) : signature;

  // SHA-256 produces exactly 32 bytes → 64 hex characters.
  if (hex.length !== 64) return null;
  if (!/^[0-9a-f]+$/i.test(hex)) return null;

  return hex.toLowerCase();
}

// ── Timing-safe comparison ────────────────────────────────────────────────────

/**
 * Constant-time string comparison for hex digests.
 *
 * In Node we delegate to `crypto.timingSafeEqual` which operates on
 * `Buffer`s. In browser / edge environments we implement a manual XOR
 * accumulator over the character codes. Both reject unequal-length strings
 * in constant time (length leak is acceptable for fixed-length hex digests).
 */
async function _timingSafeEqual(a: string, b: string): Promise<boolean> {
  // Different lengths cannot be equal; short-circuit without exposing which
  // characters differ.
  if (a.length !== b.length) return false;

  if (!_hasWebCrypto) {
    // Node.js path — dynamically import `node:crypto` to stay tree-shakeable
    // in browser bundles.
    const { timingSafeEqual, createHmac: _c } = await import("node:crypto");
    const aBuf = Buffer.from(a, "hex");
    const bBuf = Buffer.from(b, "hex");
    return timingSafeEqual(aBuf, bBuf);
  }

  // Browser / edge path — manual XOR accumulator.
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return acc === 0;
}

// ── HMAC computation ──────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256(`secret`, `payload`) and return the hex digest.
 */
async function _hmacSha256Hex(payload: string, secret: string): Promise<string> {
  if (_hasWebCrypto) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Node.js path.
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", secret).update(payload).digest("hex");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Verifies an AtlaSent webhook payload signature.
 *
 * AtlaSent signs webhook payloads with HMAC-SHA256 using your webhook secret.
 * The signature is sent in the `X-AtlaSent-Signature` header as `"sha256=<hex>"`.
 *
 * @param payload   - Raw request body as a string (do **not** parse before verifying)
 * @param signature - Value of the `X-AtlaSent-Signature` header
 * @param secret    - Your webhook signing secret
 * @returns `true` if the signature is valid, `false` otherwise
 *
 * @remarks
 * Returns `false` (does not throw) for malformed or missing signatures.
 * Use {@link assertWebhook} if you prefer exception-based control flow.
 */
export async function verifyWebhook(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  try {
    const expectedHex = _extractHex(signature);
    if (expectedHex === null) return false;

    const actualHex = await _hmacSha256Hex(payload, secret);
    return await _timingSafeEqual(actualHex, expectedHex);
  } catch {
    return false;
  }
}

/**
 * Same as {@link verifyWebhook} but throws {@link WebhookVerificationError}
 * on failure instead of returning `false`. Useful in middleware where
 * throwing is cleaner than inspecting a boolean return value.
 *
 * @param payload   - Raw request body as a string (do **not** parse before verifying)
 * @param signature - Value of the `X-AtlaSent-Signature` header
 * @param secret    - Your webhook signing secret
 * @throws {@link WebhookVerificationError} if the signature is invalid or malformed
 */
export async function assertWebhook(
  payload: string,
  signature: string,
  secret: string,
): Promise<void> {
  const valid = await verifyWebhook(payload, signature, secret);
  if (!valid) {
    throw new WebhookVerificationError(
      "Webhook signature verification failed: the signature does not match the payload.",
    );
  }
}
