import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  verifyEvidenceBundle,
  BundleVerificationError,
  canonicalJson,
  type KeySet,
} from '../src/evidence-bundle-verifier';

const VEC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'contract',
  'vectors',
  'evidence-bundles',
);
const load = (name: string) => JSON.parse(readFileSync(join(VEC, name), 'utf8'));
const keySet = load('key-set.json') as KeySet;

async function reason(name: string): Promise<string> {
  try {
    await verifyEvidenceBundle(load(name), keySet);
    return '<no-error>';
  } catch (e) {
    return e instanceof BundleVerificationError ? e.reason : `<${(e as Error).name}>`;
  }
}

describe('verifyEvidenceBundle (cross-language fixtures)', () => {
  it('accepts a valid, signed, chain-bound bundle', async () => {
    const r = await verifyEvidenceBundle(load('valid-3-records.json'), keySet);
    expect(r.ok).toBe(true);
    expect(r.record_count).toBe(3);
    expect(r.checks).toEqual(['signature', 'chain_binding', 'summary_hash']);
    expect(r.key_id).toBe('evidence-issuing-2026-06');
  });

  it('agrees with the Python verifier on non-ASCII content (raw UTF-8)', async () => {
    const r = await verifyEvidenceBundle(load('valid-unicode.json'), keySet);
    expect(r.ok).toBe(true);
    expect(r.record_count).toBe(2);
  });

  it('rejects each tampered / inconsistent fixture with the right reason', async () => {
    expect(await reason('tampered-signature.json')).toBe('signature_invalid');
    expect(await reason('broken-chain.json')).toBe('chain_broken');
    expect(await reason('unknown-key.json')).toBe('unknown_key_id');
    expect(await reason('anchor-mismatch.json')).toBe('chain_anchor_mismatch');
    expect(await reason('summary-mismatch.json')).toBe('summary_hash_mismatch');
    expect(await reason('entry-tampered.json')).toBe('chain_broken');
  });

  it('rejects malformed inputs before any crypto', async () => {
    await expect(verifyEvidenceBundle(null, keySet)).rejects.toMatchObject({ reason: 'bad_format' });
    await expect(verifyEvidenceBundle({}, keySet)).rejects.toMatchObject({ reason: 'bad_format' });
    const noKeyId = load('valid-3-records.json');
    delete noKeyId.signature.key_id;
    await expect(verifyEvidenceBundle(noKeyId, keySet)).rejects.toMatchObject({ reason: 'bad_format' });
    const badAlg = load('valid-3-records.json');
    badAlg.signature.alg = 'RS256';
    await expect(verifyEvidenceBundle(badAlg, keySet)).rejects.toMatchObject({ reason: 'bad_format' });
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every depth and is compact', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson([3, { z: true, a: null }])).toBe('[3,{"a":null,"z":true}]');
  });
  it('serializes scalars like the Python twin', () => {
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(42)).toBe('42');
  });
  it('rejects non-integer numbers (v1 has no float canonicalization)', () => {
    expect(() => canonicalJson(1.5)).toThrow(BundleVerificationError);
  });
});
