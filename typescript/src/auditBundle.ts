/**
 * Offline verification for audit export bundles.
 *
 * Mirrors `atlasent-api/supabase/functions/v1-audit/verify.ts`. The
 * reference verifier there is the source of truth; this module must
 * stay byte-identical with it on the canonicalization + signing path
 * so a bundle that verifies in the backend verifies here (and vice
 * versa).
 *
 * Primary entry point:
 *
 * ```ts
 * import { verifyBundle } from "@atlasent/sdk";
 * const result = await verifyBundle("export.json", { publicKeysPem: [pem] });
 * ```
 *
 * Node 20+ ships Ed25519 in `crypto.webcrypto.subtle`, so no extra
 * dependencies are required.
 */
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const GENESIS_HASH = "0".repeat(64);

const subtle = webcrypto.subtle;

/** Node's webcrypto CryptoKey — kept local so the module doesn't depend on DOM types. */
type WebCryptoKey = webcrypto.CryptoKey;

/** Public key candidate the verifier will try, tagged with its registry id. */
export interface VerifyKey {
  keyId: string;
  publicKey: WebCryptoKey;
}

export interface BundleVerificationResult {
  /**
   * AND of three checks: adjacency (each event's `previous_hash`
   * equals the prior event's `hash`), per-event hash recomputation
   * from the canonical payload, and `chain_head_hash` matching the
   * last event's stored hash.
   */
  chainIntegrityOk: boolean;
  /** Ed25519 signature verified against one of the supplied public keys. */
  signatureValid: boolean;
  /** `chain_head_hash` equals the last event's stored `hash`. */
  headHashMatches: boolean;
  /** Event ids whose recomputed hash != stored hash. */
  tamperedEventIds: string[];
  /** Which registry key id matched, when `signatureValid` is true. */
  matchedKeyId?: string | undefined;
  /** Non-fatal explanation when a flag is false. */
  reason?: string | undefined;
  /** Convenience: `chainIntegrityOk && signatureValid`. */
  verified: boolean;
}

/** Parsed bundle shape the verifier consumes. Fields beyond these are ignored. */
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
  /** Already-imported keys, paired with registry ids (rotation hint). */
  keys?: readonly VerifyKey[];
}

// ─── Canonicalization ─────────────────────────────────────────────────────────

/**
 * Reproduces `_shared/rules.ts::canonicalJSON` byte-for-byte:
 *   - object keys sorted at every depth
 *   - no whitespace
 *   - `null`, `undefined`, `NaN`, `±Infinity` all render as `"null"`
 *   - strings use standard `JSON.stringify` escapes
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
  }
  return "null";
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Envelope reconstruction ──────────────────────────────────────────────────

/**
 * Recreate the exact bytes `handleExport` signed. Key order is
 * load-bearing — must match the object literal in
 * `v1-audit/index.ts::handleExport`. V8 preserves insertion order, so
 * the literal below is byte-identical with what the backend signs.
 */
export function signedBytesFor(bundle: AuditBundle): Uint8Array {
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

async function verifyChainEvents(
  events: ChainEvent[],
): Promise<{ adjacencyOk: boolean; tamperedIds: string[] }> {
  const tamperedIds: string[] = [];
  let adjacencyOk = true;
  const first = events[0];
  let prevHash =
    first && typeof first.previous_hash === "string" ? first.previous_hash : GENESIS_HASH;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e.hash !== "string" || typeof e.previous_hash !== "string") {
      tamperedIds.push(String(e?.id ?? `index_${i}`));
      adjacencyOk = false;
      continue;
    }
    if (e.previous_hash !== prevHash) adjacencyOk = false;

    const canonical = canonicalJSON(e.payload ?? {});
    const recomputed = await sha256Hex(prevHash + canonical);
    if (recomputed !== e.hash) tamperedIds.push(String(e.id));

    prevHash = e.hash;
  }

  return { adjacencyOk, tamperedIds };
}

// ─── Signature verification ───────────────────────────────────────────────────

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = Buffer.from(b64, "base64");
  return new Uint8Array(bin);
}

async function importSpkiPem(pem: string): Promise<WebCryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
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
        const pk = await importSpkiPem(pem);
        out.push({ keyId: `pem_${i}`, publicKey: pk });
      } catch {
        // Malformed PEM — skip it, try the rest.
      }
    }
  }
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function verifyAuditBundle(
  bundle: AuditBundle,
  keys: readonly VerifyKey[],
): Promise<BundleVerificationResult> {
  const events: ChainEvent[] = Array.isArray(bundle.events) ? (bundle.events as ChainEvent[]) : [];

  const { adjacencyOk, tamperedIds } = await verifyChainEvents(events);

  const last = events[events.length - 1];
  const lastHash = last && typeof last.hash === "string" ? last.hash : GENESIS_HASH;
  const headHashMatches =
    typeof bundle.chain_head_hash === "string" ? bundle.chain_head_hash === lastHash : false;

  const chainIntegrityOk = adjacencyOk && tamperedIds.length === 0 && headHashMatches;

  let signatureValid = false;
  let matchedKeyId: string | undefined;
  let reason: string | undefined;

  if (keys.length === 0) {
    reason =
      "no signing keys configured (signing_keys table empty and ATLASENT_EXPORT_SIGNING_KEY_PUBLIC unset)";
  } else if (typeof bundle.signature !== "string" || bundle.signature.length === 0) {
    reason = "bundle carries no signature";
  } else {
    try {
      const sigBytes = base64UrlDecode(bundle.signature);
      const envelopeBytes = signedBytesFor(bundle);
      const hint = typeof bundle.signing_key_id === "string" ? bundle.signing_key_id : null;
      const ordered = hint
        ? [
            ...keys.filter((k) => k.keyId === hint),
            ...keys.filter((k) => k.keyId !== hint),
          ]
        : Array.from(keys);
      for (const k of ordered) {
        const ok = await subtle.verify("Ed25519", k.publicKey, sigBytes, envelopeBytes);
        if (ok) {
          signatureValid = true;
          matchedKeyId = k.keyId;
          break;
        }
      }
      if (!signatureValid) {
        reason = `signature did not verify under any of ${keys.length} configured public key(s)`;
      }
    } catch (err) {
      reason = `signature check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (!chainIntegrityOk && reason === undefined) {
    if (tamperedIds.length > 0) reason = `hash mismatch for ${tamperedIds.length} event(s)`;
    else if (!adjacencyOk) reason = "chain adjacency broken";
    else if (!headHashMatches) reason = "chain_head_hash does not match last event";
  }

  return {
    chainIntegrityOk,
    signatureValid,
    headHashMatches,
    tamperedEventIds: tamperedIds,
    matchedKeyId,
    reason,
    verified: chainIntegrityOk && signatureValid,
  };
}

/**
 * Load a bundle from disk (or a parsed object) and verify it.
 *
 * `publicKeysPem` is the active SPKI-PEM set from
 * `GET /v1-signing-keys`. When omitted, the chain check still runs
 * but `signatureValid` will be false with an explanatory `reason` —
 * callers that want a complete offline check MUST supply the trust
 * set.
 */
export async function verifyBundle(
  pathOrBundle: string | AuditBundle,
  options?: VerifyBundleOptions,
): Promise<BundleVerificationResult> {
  let bundle: AuditBundle;
  if (typeof pathOrBundle === "string") {
    const raw = await readFile(pathOrBundle, "utf8");
    const parsed = JSON.parse(raw);
    // Fixture wrapper shape: { description, bundle }. Accepted for ergonomics.
    bundle =
      parsed && typeof parsed === "object" && "bundle" in parsed && typeof parsed.bundle === "object"
        ? (parsed.bundle as AuditBundle)
        : (parsed as AuditBundle);
  } else {
    bundle = pathOrBundle;
  }
  const keys = await resolveKeys(options);
  return verifyAuditBundle(bundle, keys);
}
