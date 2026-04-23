/**
 * Offline audit bundle verifier.
 *
 * Validates an Ed25519-signed audit export bundle produced by the
 * AtlaSent API without making any network calls.
 *
 * Requires Node.js ≥ 20 (built-in `node:crypto` with Web Crypto Ed25519).
 *
 * @example
 * ```ts
 * import { verifyBundle } from "@atlasent/sdk/audit";
 *
 * const result = await verifyBundle("/path/to/export.bundle.json");
 * if (result.valid) {
 *   console.log(`Bundle OK — ${result.eventCount} events`);
 * } else {
 *   console.error(`Tampered or wrong key: ${result.error}`);
 * }
 * ```
 */

import { readFile } from "node:fs/promises";
import type { BundleVerifyResult } from "./types.js";

/** Raw shape expected inside a bundle file. */
interface BundleFile {
  version?: string;
  events: unknown[];
  public_key: string;
  signature: string;
}

/**
 * Verify an Ed25519-signed AtlaSent audit export bundle.
 *
 * Reads the JSON bundle at `path`, reconstructs the canonical payload
 * (sorted-key JSON of the `events` array), and verifies the Ed25519
 * signature stored in the bundle header.
 *
 * @param path - Filesystem path to the `.bundle.json` file.
 * @returns {@link BundleVerifyResult} — check `.valid`.
 * @throws `Error` if the file is missing, not valid JSON, or lacks
 *   required fields (`events`, `public_key`, `signature`).
 */
export async function verifyBundle(path: string): Promise<BundleVerifyResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Cannot read audit bundle at ${path}: ${err instanceof Error ? err.message : err}`,
    );
  }

  let bundle: BundleFile;
  try {
    bundle = JSON.parse(raw) as BundleFile;
  } catch (err) {
    throw new Error(
      `Audit bundle at ${path} is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
  }

  for (const field of ["events", "public_key", "signature"] as const) {
    if (!(field in bundle)) {
      throw new Error(`Audit bundle missing required field: "${field}"`);
    }
  }

  const { events, public_key, signature } = bundle;

  // Canonical payload: sorted-key JSON of the events array.
  const canonical = new TextEncoder().encode(canonicalize(events));

  const { valid, error } = await ed25519Verify(canonical, public_key, signature);

  return {
    valid,
    eventCount: events.length,
    publicKey: public_key,
    error,
  };
}

/** Recursively serialize `value` with sorted object keys (no spaces). */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) =>
      JSON.stringify(k) +
      ":" +
      canonicalize((value as Record<string, unknown>)[k]),
  );
  return "{" + pairs.join(",") + "}";
}

async function ed25519Verify(
  message: Uint8Array,
  publicKeyHex: string,
  signatureHex: string,
): Promise<{ valid: boolean; error: string }> {
  let pubBytes: Uint8Array;
  try {
    pubBytes = hexToBytes(publicKeyHex);
  } catch {
    return { valid: false, error: "Invalid public_key hex encoding" };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(signatureHex);
  } catch {
    return { valid: false, error: "Invalid signature hex encoding" };
  }

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await globalThis.crypto.subtle.importKey(
      "raw",
      pubBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch (err) {
    return {
      valid: false,
      error: `Failed to import public key: ${err instanceof Error ? err.message : err}`,
    };
  }

  let valid: boolean;
  try {
    valid = await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      cryptoKey,
      sigBytes,
      message,
    );
  } catch (err) {
    return {
      valid: false,
      error: `Signature verification error: ${err instanceof Error ? err.message : err}`,
    };
  }

  return {
    valid,
    error: valid
      ? ""
      : "Signature verification failed — bundle may be tampered",
  };
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Odd-length hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`Invalid hex at position ${i}`);
    bytes[i / 2] = byte;
  }
  return bytes;
}
