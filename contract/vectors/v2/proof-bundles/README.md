# v2 proof-bundle contract vectors — DRAFT

**Status:** DRAFT v2 preview. Fixtures reproduce byte-identically via
`contract/tools/gen_proof_bundles.py` (deterministic Ed25519 seeds +
canonical JSON). Regenerate with:

```bash
python contract/tools/gen_proof_bundles.py
```

## What's in here

Each `*.json` file is a **proof bundle** — a list of
`Proof` objects (see `contract/schemas/v2/proof.schema.json`) plus a
`description` and `expected` block documenting what a correct v2
replay harness should report. Both SDK previews
(`@atlasent/sdk-v2-preview`, `atlasent-v2-preview`) consume these
fixtures in their test suites so cross-language parity is locked at
CI time.

| Fixture | Scenario | Expected |
|---|---|---|
| `valid.json` | 3-proof chain signed by the active key | passed=3 |
| `tampered-payload.json` | `proofs[1].payload_hash` mutated after signing | passed=2, failed=1, `invalid_signature` at index 1 |
| `broken-chain.json` | `proofs[1].previous_hash` re-pointed and re-signed | passed=2, failed=1, `broken_chain` at index 1 |
| `pending.json` | `proofs[1].execution_status='pending'` | non-strict: passed=2, incomplete=1; strict: passed=2, failed=1 |
| `wrong-key.json` | Signed by a different key, advertised as active | passed=0, failed=3, `invalid_signature` |
| `rotated-key.json` | Signed by active, `signing_key_id='v2-proof-key-retired'` | with active key: passed=3 (rotation fallback); with retired key only: failed=3, `retired_signing_key` |

## Signing keys

- **`signing-key.pub.pem`** — active signer's SPKI-PEM public key.
  Registry id: `v2-proof-key-active`. This is the "audit-export-pub.pem"
  auditors / CI jobs load into `replayProofBundle(..., { keys: [...] })`.
- **`other-key.pub.pem`** — a second key used by `wrong-key.json` so
  that fixture has a reproducible failure path and can ALSO be
  verified (for cross-check) under its own key. Registry id:
  `v2-proof-key-other`.

Private keys are NOT committed. The generator derives them from a
fixed 32-byte seed documented in `gen_proof_bundles.py`; the seed
is public and test-only.

## Signed-envelope convention

Every proof's `signature` field covers canonical JSON of the
**16-field subset** of the Proof envelope, in `proof.schema.json`
declaration order, excluding `signature` and `signing_key_id`
(which can't be inside the bytes they cover). See the SDK-side
replay harnesses for the enforced field list:

- TypeScript: `typescript/packages/v2-preview/src/verifyProof.ts`
  (`SIGNED_ENVELOPE_FIELDS` constant)
- Python: `python/atlasent_v2_preview/atlasent_v2_preview/verify_proof.py`
  (`SIGNED_ENVELOPE_FIELDS` constant)
- Generator: `contract/tools/gen_proof_bundles.py`
  (`SIGNED_FIELDS` constant)

All three lists MUST stay in lockstep. Reordering or adding fields is
a breaking change.

## Schema sync

Every fixture's `proofs[]` elements validate against
`contract/schemas/v2/proof.schema.json` as JSON Schema Draft 2020-12.
The schema's `required` list plus the generator's `SIGNED_FIELDS`
constant are the two places where the canonical 18-field / 16-field
contract lives today.

## Open contract question

`contract/schemas/v2/README.md` §"Open contract-level questions" #1
flags the signed-subset ambiguity — the schema describes 18 fields
but only 16 go into the signature. These fixtures instantiate the
16-field interpretation (the one both SDK previews codify). API
team sign-off will either confirm or require regenerating these
fixtures against a different convention; in the latter case,
re-running the generator after adjusting `SIGNED_FIELDS` is the
one-command remediation.

## Not in this PR

- Per-language test files that consume these fixtures. Those land
  alongside the v2-preview replay harness PRs (#64, #65) once v1
  GA frees that workstream to move.
- The `verify.json` / SSE fixtures for `decision-event.schema.json`
  (Pillar 3). Those wait on PR #61's `decision-event` schema
  stabilising.
- Batch-evaluate response fixtures (Pillar 2). Same reason.
