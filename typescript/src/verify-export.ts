/**
 * Offline verifier for a signed AtlaSent audit-export bundle.
 *
 * Fed an envelope returned from {@link AtlaSentClient.exportAudit}
 * (or loaded from disk), this verifies:
 *
 *  1. For each row in the execution + admin chains,
 *     `sha256(canonical_payload) === entry_hash`.
 *  2. Each row's `canonical_payload` ends with the previous row's
 *     `entry_hash` (or `"GENESIS"` for row 0).
 *  3. The Ed25519 signature over
 *     `canonicalize(envelope - signature)` verifies against the
 *     embedded `public_key_pem`.
 *  4. When `trustedPublicKeyPem` is supplied, that the embedded key
 *     matches it byte-for-byte — so the verifier trusts a key **you**
 *     provisioned, not one shipped inside the envelope.
 *
 * Zero runtime dependencies — uses `node:crypto` only. Node 20+.
 */

import {
  createPublicKey,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { readFile } from "node:fs/promises";

import { canonicalize, sha256Hex } from "./canonical.js";

export interface VerifyBundleResult {
  /** Every chain row hashes to its `entry_hash` and links to the previous. */
  chainOk: boolean;
  /** The Ed25519 signature verifies against the embedded public key. */
  signatureOk: boolean;
  /**
   * `true` when the embedded public key matches `trustedPublicKeyPem`.
   * `null` when no trust anchor was supplied (so not checked).
   */
  trustedKeyOk: boolean | null;
  /** Human-readable diagnostics — empty on a clean verify. */
  errors: string[];
  /**
   * `true` iff `chainOk && signatureOk && (trustedKeyOk !== false)`.
   */
  ok: boolean;
}

export interface VerifyBundleOptions {
  /**
   * The Ed25519 public key you trust, provisioned out of band. When
   * supplied, the verifier asserts the envelope's embedded key matches
   * byte-for-byte.
   */
  trustedPublicKeyPem?: string;
}

/**
 * Verify a signed audit-export envelope without hitting the API.
 *
 * Accepts either the parsed envelope object (from
 * `bundle.raw`, `JSON.parse(...)`, etc.) or a filesystem path to a
 * JSON file.
 */
export async function verifyBundle(
  input: Record<string, unknown> | string,
  options: VerifyBundleOptions = {},
): Promise<VerifyBundleResult> {
  let envelope: Record<string, unknown>;
  if (typeof input === "string") {
    const text = await readFile(input, "utf8");
    envelope = JSON.parse(text) as Record<string, unknown>;
  } else if (input !== null && typeof input === "object") {
    envelope = input;
  } else {
    throw new TypeError(
      "verifyBundle: input must be an envelope object or a path string",
    );
  }
  return verifyEnvelope(envelope, options.trustedPublicKeyPem);
}

function verifyEnvelope(
  envelope: Record<string, unknown>,
  trustedPublicKeyPem?: string,
): VerifyBundleResult {
  const errors: string[] = [];

  const executionRows = asRowArray(envelope.evaluations);
  const adminRows = asRowArray(envelope.admin_log);
  const chainOk =
    verifyChain(executionRows, envelope.execution_head, "execution", errors) &&
    verifyChain(adminRows, envelope.admin_head, "admin", errors);

  const signature = envelope.signature;
  const pem = envelope.public_key_pem;
  if (
    typeof signature !== "string" ||
    signature.length === 0 ||
    typeof pem !== "string" ||
    pem.length === 0
  ) {
    errors.push("missing signature or public_key_pem");
    return finalize(chainOk, false, null, errors);
  }

  let embeddedKey: KeyObject;
  try {
    embeddedKey = createPublicKey(pem);
  } catch (err) {
    errors.push(
      `could not parse embedded public key: ${(err as Error).message}`,
    );
    return finalize(chainOk, false, null, errors);
  }

  const envMinusSig: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) {
    if (k !== "signature") envMinusSig[k] = v;
  }
  const canonicalBytes = Buffer.from(canonicalize(envMinusSig), "utf8");

  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(signature, "base64");
  } catch (err) {
    errors.push(`signature is not valid base64: ${(err as Error).message}`);
    return finalize(chainOk, false, null, errors);
  }

  let signatureOk = false;
  try {
    signatureOk = nodeVerify(null, canonicalBytes, embeddedKey, sigBytes);
  } catch (err) {
    errors.push(
      `signature verification threw: ${(err as Error).message}`,
    );
    signatureOk = false;
  }
  if (!signatureOk) {
    errors.push("signature does not verify against embedded public key");
  }

  let trustedKeyOk: boolean | null = null;
  if (trustedPublicKeyPem !== undefined) {
    trustedKeyOk = pemNormalize(trustedPublicKeyPem) === pemNormalize(pem);
    if (!trustedKeyOk) {
      errors.push("embedded public key does not match the trusted anchor");
    }
  }

  return finalize(chainOk, signatureOk, trustedKeyOk, errors);
}

function finalize(
  chainOk: boolean,
  signatureOk: boolean,
  trustedKeyOk: boolean | null,
  errors: string[],
): VerifyBundleResult {
  return {
    chainOk,
    signatureOk,
    trustedKeyOk,
    errors,
    ok: chainOk && signatureOk && trustedKeyOk !== false,
  };
}

function asRowArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value as Array<Record<string, unknown>>;
}

function verifyChain(
  rows: Array<Record<string, unknown>>,
  claimedHead: unknown,
  label: string,
  errors: string[],
): boolean {
  let prev: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const payload = row.canonical_payload;
    const stored = row.entry_hash;
    if (typeof payload !== "string" || typeof stored !== "string") {
      errors.push(
        `${label} row ${i}: missing canonical_payload or entry_hash`,
      );
      return false;
    }
    if (sha256Hex(payload) !== stored) {
      errors.push(
        `${label} row ${i} (${String(
          row.id,
        )}): sha256(canonical_payload) !== entry_hash`,
      );
      return false;
    }
    const segments = payload.split("|");
    const payloadPrev = segments[segments.length - 1] ?? "";
    const expectedPrev = prev ?? "GENESIS";
    if (payloadPrev !== expectedPrev) {
      errors.push(
        `${label} row ${i}: payload prev '${payloadPrev}' !== '${expectedPrev}'`,
      );
      return false;
    }
    prev = stored;
  }

  if (
    rows.length > 0 &&
    claimedHead &&
    typeof claimedHead === "object" &&
    (claimedHead as Record<string, unknown>).entry_hash !== prev
  ) {
    errors.push(
      `${label}: claimed head ${String(
        (claimedHead as Record<string, unknown>).entry_hash,
      )} does not match tail ${prev}`,
    );
    return false;
  }
  return true;
}

function pemNormalize(pem: string): string {
  return pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .replace(/ /g, "")
    .trim();
}
