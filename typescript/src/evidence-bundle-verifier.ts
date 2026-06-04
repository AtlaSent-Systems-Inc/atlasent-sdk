/**
 * Offline reference verifier for AtlaSent evidence bundles (TypeScript half of
 * the reference-implementation pair; see python/atlasent/evidence_bundle_verifier.py).
 *
 * Implements the verification path of
 * `atlasent-docs/architecture/evidence-bundles-spec.md` §4–§5 (v1):
 *   1. Ed25519 signature over `SHA-256(canonical-JSON, signature omitted)`.
 *   2. Audit-chain binding (per-record entry_hash/prev_hash + chain_context anchors).
 *   3. summary_hash = RFC 6962 Merkle root over the record entry_hash leaves.
 *
 * Offline by design: with a pinned key set it needs no network. The
 * canonicalization here MUST stay byte-identical to the Python twin.
 *
 * Pinned canonicalization decisions (v1 reference rules — see the matching
 * notes in the spec and the Python module):
 *   - Canonical JSON = recursively key-sorted, compact; strings use raw UTF-8
 *     escaping (JSON.stringify == Python json.dumps(ensure_ascii=False)), so
 *     the two verifiers agree byte-for-byte on non-ASCII content too.
 *   - entry_hash = audit-chain form: sha256(prev_hash_bytes ‖ canonical(record without entry_hash)).
 *   - summary_hash = RFC 6962 Merkle root over leaves = raw entry_hash bytes.
 */

export type VerificationReason =
  | 'bad_format'
  | 'unknown_key_id'
  | 'signature_invalid'
  | 'chain_broken'
  | 'chain_anchor_mismatch'
  | 'summary_hash_mismatch';

export class BundleVerificationError extends Error {
  readonly reason: VerificationReason;
  constructor(reason: VerificationReason, message: string) {
    super(`${reason}: ${message}`);
    this.name = 'BundleVerificationError';
    this.reason = reason;
  }
}

export interface IssuingKey {
  key_id: string;
  alg: string;
  public_key_b64: string;
}
export interface KeySet {
  issuing_keys: IssuingKey[];
}

export interface VerifyResult {
  ok: true;
  bundle_id?: string;
  key_id: string;
  record_count: number;
  checks: string[];
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// ─── Canonicalization + hashing ──────────────────────────────────────────────

/** Recursively key-sorted, compact JSON. Byte-identical to the Python twin. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new BundleVerificationError('bad_format', 'non-integer numbers are not canonicalizable in v1');
    }
    return String(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return '{' + parts.join(',') + '}';
  }
  throw new BundleVerificationError('bad_format', `uncanonicalizable type: ${typeof value}`);
}

function toBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer));
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  return hex(await sha256(data));
}

/**
 * Audit-chain entry_hash (architecture/specs/audit-chain-canonical-form.md):
 * sha256_hex(previous_hash_bytes ‖ canonical(record without entry_hash)),
 * where previous_hash_bytes is the raw 32-byte digest of prev_hash
 * (genesis = 32 zero bytes). prev_hash stays in the canonical payload.
 */
async function recordEntryHash(record: Record<string, unknown>): Promise<string> {
  const content: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== 'entry_hash' && k !== 'signature') content[k] = v;
  }
  const prevBytes = fromHex(record.prev_hash as string);
  return sha256Hex(concat([prevBytes, toBytes(canonicalJson(content))]));
}

async function merkleRootHex(leafHexes: string[]): Promise<string> {
  if (leafHexes.length === 0) return sha256Hex(new Uint8Array());
  let level: Uint8Array[] = [];
  for (const h of leafHexes) {
    level.push(await sha256(concat([new Uint8Array([0x00]), fromHex(h)])));
  }
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      if (right !== undefined) {
        next.push(await sha256(concat([new Uint8Array([0x01]), left, right])));
      } else {
        next.push(left); // odd node promoted
      }
    }
    level = next;
  }
  return hex(level[0]!);
}

function concat(arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// ─── Verification ────────────────────────────────────────────────────────────

function req(cond: boolean, reason: VerificationReason, message: string): void {
  if (!cond) throw new BundleVerificationError(reason, message);
}

async function resolveKey(keySet: KeySet, keyId: string): Promise<CryptoKey> {
  for (const k of keySet.issuing_keys ?? []) {
    if (k.key_id === keyId) {
      req(k.alg === 'Ed25519', 'signature_invalid', `unsupported key alg: ${k.alg}`);
      return crypto.subtle.importKey(
        'raw',
        fromB64(k.public_key_b64) as unknown as ArrayBuffer,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
    }
  }
  throw new BundleVerificationError('unknown_key_id', `key_id not in key set: ${keyId}`);
}

/** Verify an evidence bundle against a pinned key set. Throws on any failure. */
export async function verifyEvidenceBundle(bundle: unknown, keySet: KeySet): Promise<VerifyResult> {
  req(typeof bundle === 'object' && bundle !== null, 'bad_format', 'bundle is not an object');
  const b = bundle as Record<string, Json>;
  for (const f of ['records', 'chain_context', 'summary_hash', 'signature']) {
    req(f in b, 'bad_format', `missing field: ${f}`);
  }
  const sig = b.signature as Record<string, Json>;
  req(typeof sig === 'object' && sig !== null, 'bad_format', 'signature is not an object');
  req(sig.alg === 'Ed25519', 'bad_format', 'unsupported signature alg');
  for (const f of ['key_id', 'signature_b64']) req(f in sig, 'bad_format', `missing signature.${f}`);

  // 1. Signature over canonical bytes (signature omitted), SHA-256 then Ed25519.
  const key = await resolveKey(keySet, sig.key_id as string);
  const signingInput: Record<string, Json> = {};
  for (const [k, v] of Object.entries(b)) if (k !== 'signature') signingInput[k] = v;
  const digest = await sha256(toBytes(canonicalJson(signingInput)));
  const ok = await crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    fromB64(sig.signature_b64 as string) as unknown as ArrayBuffer,
    digest as unknown as ArrayBuffer,
  );
  req(ok, 'signature_invalid', 'Ed25519 signature did not verify');

  // 2. Chain binding (spec §5.3).
  const records = b.records as Array<Record<string, Json>>;
  const chain = b.chain_context as Record<string, Json>;
  req(Array.isArray(records) && records.length > 0, 'bad_format', 'no records');
  req(chain.entry_count === records.length, 'chain_anchor_mismatch',
    'chain_context.entry_count != number of records');
  let prev: Json | undefined = chain.first_prev_hash;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    req((await recordEntryHash(rec)) === rec.entry_hash, 'chain_broken',
      `record[${i}].entry_hash does not match recomputed content hash`);
    req(rec.prev_hash === prev, 'chain_broken',
      `record[${i}].prev_hash does not link to the prior entry`);
    prev = rec.entry_hash;
  }
  req(records[0]!.entry_hash === chain.first_entry_hash, 'chain_anchor_mismatch',
    'chain_context.first_entry_hash mismatch');
  req(records[records.length - 1]!.entry_hash === chain.last_entry_hash, 'chain_anchor_mismatch',
    'chain_context.last_entry_hash mismatch');

  // 3. summary_hash = RFC 6962 Merkle root over record entry_hash leaves.
  const expectedRoot = await merkleRootHex(records.map((r) => r.entry_hash as string));
  req(expectedRoot === b.summary_hash, 'summary_hash_mismatch',
    'recomputed Merkle root does not match summary_hash');

  const result: VerifyResult = {
    ok: true,
    key_id: sig.key_id as string,
    record_count: records.length,
    checks: ['signature', 'chain_binding', 'summary_hash'],
  };
  if (typeof b.bundle_id === 'string') result.bundle_id = b.bundle_id;
  return result;
}
