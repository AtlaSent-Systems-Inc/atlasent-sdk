# `@atlasent/sdk-v2-alpha`

Alpha release of the v2 AtlaSent SDK for TypeScript / Node.

> **Status: alpha.** Surfaces are usable and tested, but the API is
> subject to change between alpha releases as the v2 wire contract
> stabilises. Pin to an exact version
> (`@atlasent/sdk-v2-alpha@2.0.0-alpha.0`) if you depend on this
> package from production code.

TypeScript sibling of
[`atlasent-v2-alpha`](../../../python/atlasent_v2_alpha/) on PyPI.
Same scope, same parity invariants — the Pillar 9 (Verifiable Proof
System) primitives that have no server dependency, plus the v2 wire
types.

## Why a separate package?

1. `@atlasent/sdk` (v1) is shipping to npm and locked at GA — it
   MUST NOT regress.
2. A net-new package gives us room to iterate on the Pillar 9
   canonicalization algorithm, proof envelope shape, and callback
   lifecycle without touching the v1 surface.
3. Adopters can install the alpha alongside v1 and start wiring
   against the v2 utilities today, with the explicit understanding
   that minor v2-alpha versions may break things.

## What's in here

| Export | Purpose |
|---|---|
| `canonicalizePayload(value)` | Deterministic canonical JSON — sorted keys, no whitespace, `null`/`undefined`/non-finite numbers → `null` |
| `hashPayload(value)` | SHA-256 hex of `canonicalizePayload(value)` |
| Types: `Proof`, `ProofVerificationResult`, `ProofVerificationCheck`, `ProofFailureReason`, `ConsumeRequest`, `ConsumeResponse` | 1:1 with the v2 schemas |

## What's coming next (tracked in subsequent PRs)

- `consume()` + `verifyProof()` — HTTP methods (PR2)
- `evaluateBatch()` — batched evaluate over `/v2-evaluate-batch` (PR3)
- `subscribeDecisions()` — SSE-based decision-event stream (PR4)

## Installation

```bash
npm install @atlasent/sdk-v2-alpha
```

```ts
import { canonicalizePayload, hashPayload } from "@atlasent/sdk-v2-alpha";
import type { Proof } from "@atlasent/sdk-v2-alpha";
```

## Relationship to `contract/schemas/v2/`

The schemas are the wire law. Every exported type is a structural
mirror of its schema; the test suite includes assertions that every
required schema field is present on the corresponding TypeScript
type so drift between schema and code fails CI.

## Relationship to the v1 `canonicalJSON`

Functionally identical. Kept in two places on purpose — v1 package
is locked at GA and must not take a runtime dependency on this
alpha; this alpha must not take a runtime dependency on v1 until
v2 GA chooses a consolidation path. `test/canonicalize.test.ts`
compares output with shared vectors to keep them honest.

## Local development

```bash
cd typescript/packages/v2-alpha
npm install
npm test
npm run typecheck
npm run build
```
