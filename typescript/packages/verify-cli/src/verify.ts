import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

export class VerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyError";
  }
}

export interface KeySetEntry {
  key_id: string;
  alg: string;
  public_key_b64: string;
}

export interface KeySet {
  issuing_keys: KeySetEntry[];
}

export interface ChainContext {
  first_prev_hash: string;
  first_entry_hash: string;
  last_entry_hash: string;
  entry_count: number;
}

export interface BundleSignature {
  alg: string;
  key_id: string;
  signature_b64: string;
}

export interface EvidenceRecord {
  prev_hash: string;
  entry_hash: string;
  [key: string]: unknown;
}

export interface EvidenceBundle {
  bundle_id?: string;
  records: EvidenceRecord[];
  chain_context: ChainContext;
  summary_hash: string;
  signature: BundleSignature;
}

export interface VerifyResult {
  ok: true;
  bundle_id: string | undefined;
  key_id: string;
  record_count: number;
  checks: ["signature", "chain_binding", "summary_hash"];
}

/** Recursively key-sorted, compact JSON — twin of the Python canonicalize() and audit-evidence-package verify.mjs. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new VerifyError("floating-point values are not canonicalizable in v1");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + (value as unknown[]).map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",") + "}";
  }
  throw new VerifyError(`uncanonicalizable type: ${typeof value}`);
}

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** entry_hash = sha256( prev_hash_bytes || canonical_json(record sans entry_hash/signature) ). */
export function recordEntryHash(record: EvidenceRecord): string {
  const content: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== "entry_hash" && k !== "signature") content[k] = v;
  }
  const prevBytes = Buffer.from(record.prev_hash, "hex");
  return sha256hex(Buffer.concat([prevBytes, Buffer.from(canonicalJson(content), "utf8")]));
}

/** RFC 6962 Merkle root (hex) over hex-string entry_hash leaves. */
export function merkleRootHex(leafHexes: string[]): string {
  if (leafHexes.length === 0) return sha256hex(Buffer.alloc(0));
  let level = leafHexes.map((h) =>
    sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(h, "hex")])),
  );
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha256(Buffer.concat([Buffer.from([0x01]), level[i]!, level[i + 1]!])));
      } else {
        next.push(level[i]!); // odd node promoted unchanged
      }
    }
    level = next;
  }
  return level[0]!.toString("hex");
}

function ed25519PublicKey(b64: string): ReturnType<typeof createPublicKey> {
  const raw = Buffer.from(b64, "base64");
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

function resolveKey(
  keySet: KeySet,
  keyId: string,
): ReturnType<typeof createPublicKey> {
  for (const k of keySet.issuing_keys ?? []) {
    if (k.key_id === keyId) {
      if (k.alg !== "Ed25519") throw new VerifyError(`unsupported key alg: ${k.alg}`);
      return ed25519PublicKey(k.public_key_b64);
    }
  }
  throw new VerifyError(`unknown_key_id: key_id not in key set: ${keyId}`);
}

function require_(cond: boolean, message: string): asserts cond {
  if (!cond) throw new VerifyError(message);
}

/**
 * Verify an AtlaSent evidence bundle against a published key set.
 *
 * Three checks — ALL must pass:
 *   1. Signature  Ed25519 over sha256(canonical_json(bundle sans `signature` field))
 *   2. Chain      each record.entry_hash == sha256(prev_hash_bytes || canonical_payload)
 *   3. Merkle     summary_hash == RFC 6962 Merkle root over entry_hash leaves
 *
 * Zero runtime dependencies — uses only node:crypto.
 * Throws VerifyError on any failure; returns VerifyResult on success.
 */
export function verifyEvidenceBundle(bundle: EvidenceBundle, keySet: KeySet): VerifyResult {
  require_(typeof bundle === "object" && bundle !== null, "bundle is not an object");
  for (const f of ["records", "chain_context", "summary_hash", "signature"] as const) {
    require_(f in bundle, `missing field: ${f}`);
  }

  const sig = bundle.signature;
  require_(typeof sig === "object" && sig !== null, "signature is not an object");
  require_(sig.alg === "Ed25519", "unsupported signature alg");
  for (const f of ["key_id", "signature_b64"] as const) {
    require_(f in sig, `missing signature.${f}`);
  }

  // 1. Signature
  const pubkey = resolveKey(keySet, sig.key_id);
  const signingInput: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bundle)) if (k !== "signature") signingInput[k] = v;
  const digest = sha256(Buffer.from(canonicalJson(signingInput), "utf8"));
  const sigOk = edVerify(null, digest, pubkey, Buffer.from(sig.signature_b64, "base64"));
  require_(sigOk, "signature_invalid: Ed25519 signature did not verify");

  // 2. Chain binding
  const records = bundle.records;
  const chain = bundle.chain_context;
  require_(Array.isArray(records) && records.length > 0, "no records");
  require_(
    chain.entry_count === records.length,
    "chain_context.entry_count != number of records",
  );
  let prev = chain.first_prev_hash;
  records.forEach((rec, i) => {
    require_(
      recordEntryHash(rec) === rec.entry_hash,
      `record[${i}].entry_hash does not match recomputed content hash`,
    );
    require_(
      rec.prev_hash === prev,
      `record[${i}].prev_hash does not link to the prior entry`,
    );
    prev = rec.entry_hash;
  });
  require_(
    records[0]!.entry_hash === chain.first_entry_hash,
    "chain_context.first_entry_hash mismatch",
  );
  require_(
    records[records.length - 1]!.entry_hash === chain.last_entry_hash,
    "chain_context.last_entry_hash mismatch",
  );

  // 3. Merkle root
  const expectedRoot = merkleRootHex(records.map((r) => r.entry_hash));
  require_(
    expectedRoot === bundle.summary_hash,
    "summary_hash_mismatch: recomputed Merkle root does not match summary_hash",
  );

  return {
    ok: true,
    bundle_id: bundle.bundle_id,
    key_id: sig.key_id,
    record_count: records.length,
    checks: ["signature", "chain_binding", "summary_hash"],
  };
}
