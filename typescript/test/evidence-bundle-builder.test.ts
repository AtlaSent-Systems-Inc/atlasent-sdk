import { describe, it, expect } from 'vitest';
import { buildEvidenceBundle, generateIssuingKey } from '../src/evidence-bundle-builder';
import { verifyEvidenceBundle } from '../src/evidence-bundle-verifier';

describe('buildEvidenceBundle (round-trips with the verifier)', () => {
  it('a built bundle verifies', async () => {
    const { keyId, privateKey, keySet } = await generateIssuingKey('k1');
    const bundle = await buildEvidenceBundle({
      records: [
        { decision_id: 'd1', decision: { action: 'x', outcome: 'permit' } },
        { decision_id: 'd2', decision: { action: 'y', outcome: 'deny' } },
      ],
      signingKey: privateKey,
      keyId,
    });
    const r = await verifyEvidenceBundle(bundle, keySet);
    expect(r.ok).toBe(true);
    expect(r.record_count).toBe(2);
    expect(r.checks).toEqual(['signature', 'chain_binding', 'summary_hash']);
  });

  it('round-trips non-ASCII record content', async () => {
    const { keyId, privateKey, keySet } = await generateIssuingKey('k1');
    const bundle = await buildEvidenceBundle({
      records: [{ decision_id: 'd1', decision: { actor: 'Frédéric / 北京' } }],
      signingKey: privateKey,
      keyId,
    });
    expect((await verifyEvidenceBundle(bundle, keySet)).ok).toBe(true);
  });

  it('rejects an empty record set', async () => {
    const { keyId, privateKey } = await generateIssuingKey('k1');
    await expect(buildEvidenceBundle({ records: [], signingKey: privateKey, keyId })).rejects.toThrow();
  });
});
