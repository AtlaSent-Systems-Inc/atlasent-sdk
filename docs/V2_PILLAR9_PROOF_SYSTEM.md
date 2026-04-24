# Pillar 9 — Verifiable Proof System: SDK workstreams

Companion to
[`atlasent-api/docs/V2_PILLAR9_PROOF_SYSTEM.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-api/pull/116).
Canonical Proof Object definition and product rationale live there.

**Do not implement until v1 GA. Do not merge until v2 GA.**

---

## SDK workstreams

### 1. Proof types in `@atlasent/types`

Add to `@atlasent/types`; re-export from `@atlasent/sdk` and `atlasent` (Python).

New types:

```typescript
// Canonical proof object
interface Proof { /* see atlasent-api/docs/V2_PILLAR9_PROOF_SYSTEM.md */ }

// Result of POST /v1/proofs/:id/verify
interface ProofVerificationResult {
  verificationStatus: 'valid' | 'invalid' | 'incomplete';
  checks: ProofVerificationCheck[];
}

interface ProofVerificationCheck {
  name: string; // e.g. 'signature', 'chain_link', 'payload_hash'
  passed: boolean;
  reason?: string; // failure reason code if !passed
}

// Failure reason codes (machine-readable)
type ProofFailureReason =
  | 'missing_policy_version'
  | 'payload_hash_mismatch'
  | 'expired_permit'
  | 'broken_chain'
  | 'invalid_signature'
  | 'retired_signing_key'
  | 'execution_not_consumed';

// Consume request
interface ConsumeRequest {
  permitId: string;
  payloadHash: string;
  executionStatus: 'executed' | 'failed';
  executionHash?: string; // optional hash of execution result metadata
}

// Consume response
interface ConsumeResponse {
  proofId: string;
  executionStatus: string;
  auditHash: string;
}
```

### 2. Payload canonicalization utility

Export from `@atlasent/sdk`:

```typescript
// Deterministic canonical JSON: all object keys sorted recursively, no whitespace
export function canonicalizePayload(payload: Record<string, unknown>): string;

// SHA-256 hex of canonicalizePayload(payload)
export function hashPayload(payload: Record<string, unknown>): string;
```

Used internally by `protect()`. Exported for customers who want to pre-compute
hashes or verify payloads independently.

Identical utility in Python: `atlasent.proof.canonicalize_payload()` and
`atlasent.proof.hash_payload()`.

### 3. `protect()` lifecycle update

Current `protect()` lifecycle: `evaluate → verifyPermit → return Permit`.

v2 adds the consume step via a callback pattern:

```typescript
const result = await atlasent.protect(
  {
    agent:   'deploy-bot',
    action:  'deploy_to_production',
    target:  'prod-cluster',
    payload: { commit, approver }, // hashed client-side; body never sent to API
  },
  async ({ permit, proof }) => {
    return await performDeployment();
  }
);
// result: { permit, proof, executionResult }
```

Lifecycle:

1. `hashPayload(payload)` → `payloadHash` (client-side, SHA-256)
2. `POST /v1/evaluate` with `payloadHash` → decision
3. On `ALLOW`: `POST /v1/permits/:id/verify` (unchanged from v1)
4. Execute user callback
5. On callback success: `POST /v1/permits/:id/consume` with
   `{ payloadHash, executionStatus: 'executed' }` → `proof.executionStatus = executed`
6. On callback error: `POST /v1/permits/:id/consume` with
   `{ payloadHash, executionStatus: 'failed', ... }` → `proof.executionStatus = failed`;
   original error is re-thrown unchanged
7. Return `{ permit, proof, executionResult }`

On `DENY` / `HOLD` / `ESCALATE`: throw `AtlaSentDeniedError` (unchanged from v1).

The existing two-step `evaluate()` + `verifyPermit()` escape hatch is preserved.
Callback pattern is the recommended path; lower-level methods remain for advanced
use cases.

### 4. Standalone `verifyProof()` method

```typescript
const result = await client.verifyProof(proofId);
// ProofVerificationResult
```

Thin wrapper over `POST /v1/proofs/:id/verify`. Available on `AtlaSentClient`
and on the process-wide singleton via `atlasent.verifyProof(proofId)`.

### 5. `@atlasent/verify` extension

The v1 offline verifier (`atlasent-api/scripts/verify-export.mjs` →
`@atlasent/verify` v1) is extended to support Proof Objects:

```bash
npx @atlasent/verify proof.json
npx @atlasent/verify bundle.json
```

Structured stdout (exit 0 = valid, exit 1 = invalid/incomplete):

```json
{
  "verificationStatus": "valid",
  "proofId": "...",
  "signingKeyId": "...",
  "auditHash": "...",
  "payloadHash": "...",
  "checks": [
    { "name": "signature",         "passed": true },
    { "name": "chain_link",         "passed": true },
    { "name": "payload_hash",       "passed": true },
    { "name": "policy_version",     "passed": true },
    { "name": "execution_coherence","passed": true }
  ]
}
```

### 6. Proof replay test harness

Export a `replayProofBundle(bundle, options)` utility for auditors and CI:

```typescript
import { replayProofBundle } from '@atlasent/verify';

const result = await replayProofBundle(bundle, {
  signingPublicKey: fs.readFileSync('audit-export-pub.pem'),
  strict: true, // fail on incomplete proofs, not just invalid
});
// result: { passed, failed, incomplete, proofs[] }
```

Allows local replay of exported bundles against a known signing public key.
No API credentials required. Designed for:
- Auditor offline review
- CI regression tests against exported bundles
- Customer self-verification of AtlaSent records

### 7. Proof SLA for batch

`client.evaluateBatch()` response items include `proofId` and `proofStatus`.
Callers use `client.getProof(proofId)` to poll, or subscribe via
`client.subscribeDecisions()` (Pillar 3) for `proof.created` events.

```typescript
const batch = await client.evaluateBatch(requests);
// batch.items[n].proofId, batch.items[n].proofStatus
```

---

## Parity invariants (Pillar 9 additions)

- `protect()` callback pattern identical in TS and Python
- `Proof` type exported from `@atlasent/sdk` and `atlasent` Python package
- `hashPayload()` / `canonicalizePayload()` utilities exported in both languages
- `@atlasent/verify` CLI output schema identical regardless of bundle origin
- `ProofFailureReason` enum identical in TS and Python

---

## Open questions

1. `protect()` raw `payload` vs pre-hashed `payloadHash` input — accept raw
   (more ergonomic) or require pre-hash (stricter zero-payload-body guarantee)?
   Recommendation: accept raw; SDK hashes internally and never forwards body.
2. Python `protect()` — `asyncio` callback or sync-only at v2.0?
3. Should `replayProofBundle()` be in `@atlasent/verify` or `@atlasent/sdk`?
   Recommendation: `@atlasent/verify` — keeps the main SDK zero-dep for
   verification use cases.
4. Node floor — `canonicalizePayload` uses `crypto.createHash('sha256')` (Node
   core, no new dep). No floor bump needed for Pillar 9 specifically.
