# `@atlasent/sdk-v2-preview` — PREVIEW, DO NOT USE IN PRODUCTION

> **Status:** DRAFT v2 preview. Marked `private: true` until v2 GA.
> Every export in this package is subject to change without semver
> discipline. Depending on this package from real code is a promise
> to follow the breakage as we iterate on the v2 wire contract.

Companion preview package for the **v2 AtlaSent SDK**. Scope limited
to the Pillar 9 (Verifiable Proof System) primitives that have no
server dependency — canonicalization, hashing, and type definitions
matching `contract/schemas/v2/`.

## Why a separate package?

1. `@atlasent/sdk` (v1) ships tomorrow. That package MUST NOT
   regress. Anything v2-track lives here until v2 GA.
2. A net-new package gives us room to iterate on the Pillar 9
   canonicalization algorithm, proof envelope shape, and callback
   lifecycle without touching the v1 surface.
3. Early-access customers can install the preview alongside v1 and
   start wiring against the eventual v2 utilities today.

## What's in here

| Export | Purpose | Spec |
|---|---|---|
| `canonicalizePayload(value)` | Deterministic canonical JSON — sorted keys, no whitespace, `null`/`undefined`/non-finite numbers → `null` | `contract/schemas/v2/README.md` §1 |
| `hashPayload(value)` | SHA-256 hex of `canonicalizePayload(value)` | `contract/schemas/v2/README.md` §1 |
| Types: `Proof`, `ProofVerificationResult`, `ProofVerificationCheck`, `ProofFailureReason`, `ConsumeRequest`, `ConsumeResponse` | 1:1 with the v2 schemas | `contract/schemas/v2/*.schema.json` |

## What's NOT in here

- Any HTTP client code. The `consume`, `verifyProof`, `evaluateBatch`,
  and `subscribeDecisions` methods land in the real v2 SDK once the
  server contract stabilises.
- Any runtime dependency on `@atlasent/sdk` (v1). The
  canonicalization algorithm is re-implemented here to match
  `auditBundle.ts::canonicalJSON` byte-for-byte (test:
  `test/canonicalize.test.ts`) so the two can converge at v2 GA
  without a publish-order dependency.
- A build step. `main` points at `src/index.ts` — consumers of this
  preview either import TypeScript directly or run the files
  through their own bundler. Proper dual-build wiring lands at
  v2 GA alongside the `private: false` flip.

## Relationship to `contract/schemas/v2/`

The schemas are the wire law. Every exported type is a structural
mirror of its schema; the test suite includes assertions that every
required schema field is present on the corresponding TypeScript
type so drift between schema and code fails CI.

## Relationship to the v1 `canonicalJSON`

Functionally identical. Kept in two places on purpose — v1 package
is locked at GA and must not take a dependency on this preview;
this preview must not take a dependency on v1 until v2 GA chooses
a consolidation path. `test/canonicalize.test.ts` compares output
with shared vectors to keep them honest.
