/**
 * @atlasent/verify — offline audit-bundle verifier.
 *
 * Zero runtime dependencies: uses only Node 20+ built-ins
 * (`node:crypto`, `node:fs/promises`).
 *
 * Mirrors the canonicalization + signing path in `atlasent-api` so
 * a bundle that verifies in the backend verifies here (and vice versa).
 *
 * Quick start:
 *
 * ```ts
 * import { verifyBundle } from "@atlasent/verify";
 *
 * const result = await verifyBundle("export.json", {
 *   publicKeysPem: [process.env.ATLASENT_EXPORT_PUBLIC_KEY!],
 * });
 * if (!result.verified) throw new Error(result.reason);
 * ```
 */

import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
const GENESIS_HASH = "0".repeat(64);

// ─── Public types ─────────────────────────────────────────────────────────────

export interface VerifyKey {
  keyId: string;
  publicKey: webcrypto.CryptoKey;
}

export interface BundleVerificationResult {
  /** AND of chain adjacency, per-event hash recomputation, and head-hash match. */
  chainIntegrityOk: boolean;
  /** Ed25519 signature verified against one of the supplied public keys. */
  signatureValid: boolean;
  /** `chain_head_hash` equals the last event's stored `hash`. */
  headHashMatches: boolean;
  /** Event ids whose recomputed hash !== stored hash. */
  tamperedEventIds: string[];
  /** Which registry key id matched, when `signatureValid` is true. */
  matchedKeyId?: string | undefined;
  /** Non-fatal explanation when a flag is false. */
  reason?: string | undefined;
  /** Convenience: `chainIntegrityOk && signatureValid`. */
  verified: boolean;
}

export interface AuditBundle {
  export_id?: unknown;
  org_id?: unknown;
  chain_head_hash?: unknown;
  event_count?: unknown;
  signed_at?: unknown;
  events?: unknown;
  signature?: unknown;
  signing_key_id?: unknown;
  [k: string]: unknown;
}

export interface VerifyBundleOptions {
  /** SPKI-PEM strings (one per key in the active trust set). */
  publicKeysPem?: readonly string[];
  /** Already-imported keys, paired with registry ids. */
  keys?: readonly VerifyKey[];
}

// ─── Canonicalization ─────────────────────────────────────────────────────────

/**
 * Reproduces `_shared/rules.ts::canonicalJSON` byte-for-byte:
 * sorted keys, no whitespace, null/undefined/NaN/±Inf → "null".
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
  }
  return "null";
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Signed-envelope reconstruction ──────────────────────────────────────────

/**
 * Recreates the exact bytes `atlasent-api/v1-audit/index.ts::handleExport`
 * signed. Key insertion order is load-bearing — must match the backend literal.
 */
export function signedBytesFor(bundle: AuditBundle): Uint8Array<ArrayBuffer> {
  const envelope = {
    export_id: bundle.export_id,
    org_id: bundle.org_id,
    chain_head_hash: bundle.chain_head_hash,
    event_count: bundle.event_count,
    signed_at: bundle.signed_at,
    events: bundle.events,
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

// ─── Chain verification ───────────────────────────────────────────────────────

interface ChainEvent {
  id?: unknown;
  hash?: unknown;
  previous_hash?: unknown;
  payload?: unknown;
}

async function verifyChainEvents(events: ChainEvent[]): Promise<{ adjacencyOk: boolean; tamperedIds: string[] }> {
  const tamperedIds: string[] = [];
  let adjacencyOk = true;
  const first = events[0];
  let prevHash = first && typeof first.previous_hash === "string" ? first.previous_hash : GENESIS_HASH;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e.hash !== "string" || typeof e.previous_hash !== "string") {
      tamperedIds.push(String(e?.id ?? `index_${i}`));
      adjacencyOk = false;
      continue;
    }
    if (e.previous_hash !== prevHash) adjacencyOk = false;
    const recomputed = await sha256Hex(prevHash + canonicalJSON(e.payload ?? {}));
    if (recomputed !== e.hash) tamperedIds.push(String(e.id));
    prevHash = e.hash;
  }

  return { adjacencyOk, tamperedIds };
}

// ─── Signature verification ───────────────────────────────────────────────────

function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = Buffer.from(b64, "base64");
  const out = new Uint8Array(bin.byteLength);
  out.set(bin);
  return out;
}

async function importSpkiPem(pem: string): Promise<webcrypto.CryptoKey> {
  const b64 = pem.replace(/-----BEGIN PUBLIC KEY-----/, "").replace(/-----END PUBLIC KEY-----/, "").replace(/\s+/g, "");
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  return subtle.importKey("spki", bytes, { name: "Ed25519" }, false, ["verify"]);
}

async function resolveKeys(options: VerifyBundleOptions | undefined): Promise<VerifyKey[]> {
  const out: VerifyKey[] = [];
  if (options?.keys) out.push(...options.keys);
  if (options?.publicKeysPem) {
    for (let i = 0; i < options.publicKeysPem.length; i++) {
      const pem = options.publicKeysPem[i];
      if (!pem) continue;
      try {
        out.push({ keyId: `pem_${i}`, publicKey: await importSpkiPem(pem) });
      } catch {
        // Malformed PEM — skip.
      }
    }
  }
  return out;
}

// ─── Core verifier ────────────────────────────────────────────────────────────

export async function verifyAuditBundle(
  bundle: AuditBundle,
  keys: readonly VerifyKey[],
): Promise<BundleVerificationResult> {
  const events: ChainEvent[] = Array.isArray(bundle.events) ? (bundle.events as ChainEvent[]) : [];

  const { adjacencyOk, tamperedIds } = await verifyChainEvents(events);

  const last = events[events.length - 1];
  const lastHash = last && typeof last.hash === "string" ? last.hash : GENESIS_HASH;
  const headHashMatches = typeof bundle.chain_head_hash === "string" ? bundle.chain_head_hash === lastHash : false;
  const chainIntegrityOk = adjacencyOk && tamperedIds.length === 0 && headHashMatches;

  let signatureValid = false;
  let matchedKeyId: string | undefined;
  let reason: string | undefined;

  if (keys.length === 0) {
    reason = "no signing keys configured";
  } else if (typeof bundle.signature !== "string" || bundle.signature.length === 0) {
    reason = "bundle carries no signature";
  } else {
    try {
      const sigBytes = base64UrlDecode(bundle.signature);
      const envelopeBytes = signedBytesFor(bundle);
      const hint = typeof bundle.signing_key_id === "string" ? bundle.signing_key_id : null;
      const ordered = hint
        ? [...keys.filter((k) => k.keyId === hint), ...keys.filter((k) => k.keyId !== hint)]
        : Array.from(keys);
      for (const k of ordered) {
        if (await subtle.verify("Ed25519", k.publicKey, sigBytes, envelopeBytes)) {
          signatureValid = true;
          matchedKeyId = k.keyId;
          break;
        }
      }
      if (!signatureValid) reason = `signature did not verify under any of ${keys.length} configured public key(s)`;
    } catch (err) {
      reason = `signature check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (!chainIntegrityOk && reason === undefined) {
    if (tamperedIds.length > 0) reason = `hash mismatch for ${tamperedIds.length} event(s)`;
    else if (!adjacencyOk) reason = "chain adjacency broken";
    else if (!headHashMatches) reason = "chain_head_hash does not match last event";
  }

  return { chainIntegrityOk, signatureValid, headHashMatches, tamperedEventIds: tamperedIds, matchedKeyId, reason, verified: chainIntegrityOk && signatureValid };
}

/**
 * Load a bundle from disk (or pass an already-parsed object) and verify it.
 *
 * Supply `publicKeysPem` (SPKI-PEM strings from `GET /v1-signing-keys`)
 * for a complete check. Without keys the chain check still runs but
 * `signatureValid` will be false.
 */
export async function verifyBundle(
  pathOrBundle: string | AuditBundle,
  options?: VerifyBundleOptions,
): Promise<BundleVerificationResult> {
  let bundle: AuditBundle;
  if (typeof pathOrBundle === "string") {
    const raw = await readFile(pathOrBundle, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Accept fixture wrapper shape: { description, bundle }
    bundle = parsed && "bundle" in parsed && typeof parsed["bundle"] === "object"
      ? (parsed["bundle"] as AuditBundle)
      : (parsed as AuditBundle);
  } else {
    bundle = pathOrBundle;
  }
  return verifyAuditBundle(bundle, await resolveKeys(options));
}
