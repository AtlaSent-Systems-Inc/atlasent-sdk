/**
 * Reference *builder* for AtlaSent evidence bundles — the producer half that
 * pairs with `evidence-bundle-verifier.ts`. Given record content + an Ed25519
 * issuing key, it assembles a spec §4 bundle (entry_hash chain, chain_context
 * anchors, RFC 6962 summary_hash) and signs it so the reference verifier
 * accepts it.
 *
 * This is a reference / test utility, NOT the production assembly service. The
 * server-side assembly milestone (atlasent-api) must reproduce this exact
 * hashing/canonicalization and sign with a real issuing key whose certificate
 * chains to a published root (see the key-management runbook). The two stay in
 * lockstep by reusing the verifier's primitives here.
 */

import {
  canonicalJson,
  recordEntryHash,
  merkleRootHex,
  type KeySet,
} from './evidence-bundle-verifier.js';

const GENESIS_PREV_HASH = '00'.repeat(32); // 32 zero bytes

export interface BuildBundleOptions {
  /** Record content WITHOUT entry_hash/prev_hash (e.g. { decision_id, decision, ... }). */
  records: Array<Record<string, unknown>>;
  /** Ed25519 private CryptoKey (usePrivateKey from generateIssuingKey, or your own). */
  signingKey: CryptoKey;
  /** key_id published in the key set; embedded in the signature block. */
  keyId: string;
  /** Defaults to the genesis 32-zero-byte prev hash. */
  firstPrevHash?: string;
  /** Optional bundle metadata; sensible defaults are filled in. */
  meta?: {
    bundle_id?: string;
    issued_at?: string;
    issued_by?: Record<string, unknown>;
    scope?: Record<string, unknown>;
    chain_id?: string;
    key_set_url?: string;
  };
}

function toBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Generate an Ed25519 issuing key + a single-key KeySet for it. */
export async function generateIssuingKey(
  keyId = 'evidence-issuing-test',
): Promise<{ keyId: string; privateKey: CryptoKey; keySet: KeySet }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    keyId,
    privateKey: pair.privateKey,
    keySet: {
      issuing_keys: [{ key_id: keyId, alg: 'Ed25519', public_key_b64: toB64(rawPub) }],
    },
  };
}

/** Assemble + sign an evidence bundle. The reference verifier accepts the result. */
export async function buildEvidenceBundle(
  opts: BuildBundleOptions,
): Promise<Record<string, unknown>> {
  const firstPrev = opts.firstPrevHash ?? GENESIS_PREV_HASH;

  // Chain the records: prev_hash links to the prior entry_hash.
  let prev = firstPrev;
  const records: Array<Record<string, unknown>> = [];
  for (const content of opts.records) {
    const rec: Record<string, unknown> = { ...content, prev_hash: prev };
    rec.entry_hash = await recordEntryHash(rec);
    records.push(rec);
    prev = rec.entry_hash as string;
  }
  if (records.length === 0) throw new Error('buildEvidenceBundle: at least one record is required');

  const entryHashes = records.map((r) => r.entry_hash as string);
  const meta = opts.meta ?? {};

  // Everything except the signature, in the order the verifier reconstructs.
  const unsigned: Record<string, unknown> = {
    $schema: 'https://atlasent.io/schemas/evidence-bundle/v1.json',
    bundle_id: meta.bundle_id ?? crypto.randomUUID(),
    bundle_version: '1',
    issued_at: meta.issued_at ?? new Date().toISOString(),
    issued_by: meta.issued_by ?? { issuer_kind: 'atlasent-sdk', issuer_version: '0' },
    ...(meta.scope ? { scope: meta.scope } : {}),
    chain_context: {
      chain_id: meta.chain_id ?? 'org-default',
      first_entry_hash: entryHashes[0],
      first_prev_hash: firstPrev,
      last_entry_hash: entryHashes[entryHashes.length - 1],
      entry_count: records.length,
    },
    records,
    summary_hash: await merkleRootHex(entryHashes),
  };

  // Sign SHA-256(canonical(unsigned)) with Ed25519 (spec §5.2).
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', toBytes(canonicalJson(unsigned)) as unknown as ArrayBuffer),
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, opts.signingKey, digest as unknown as ArrayBuffer),
  );

  return {
    ...unsigned,
    signature: {
      alg: 'Ed25519',
      key_id: opts.keyId,
      key_set_url: meta.key_set_url ?? 'https://trust.atlasent.io/keys/evidence-bundles.json',
      signature_b64: toB64(sigBytes),
    },
  };
}
