# `atlasent-v2-preview` — PREVIEW, DO NOT USE IN PRODUCTION

> **Status:** DRAFT v2 preview. Version pinned at `2.0.0a0` and
> classified as `Pre-Alpha`. Every export in this package is subject
> to change without semver discipline. Depending on this package from
> real code is a promise to follow the breakage as we iterate on the
> v2 wire contract.

Python sibling of
[`@atlasent/sdk-v2-preview`](../../typescript/packages/v2-preview/).
Same scope, same rules, same parity invariants — the Pillar 9
primitives that have no server dependency.

## Why a separate package?

1. `atlasent` (v1) ships to PyPI tomorrow. That package MUST NOT
   regress. Anything v2-track lives here until v2 GA.
2. A net-new package gives us room to iterate on the Pillar 9
   canonicalization algorithm, proof envelope shape, and callback
   lifecycle without touching the v1 surface in `python/atlasent/`.
3. Early-access customers can `pip install atlasent-v2-preview`
   alongside v1 and start wiring against the eventual v2 utilities
   today.

## What's in here

| Export | Purpose | Spec |
|---|---|---|
| `canonicalize_payload(value)` | Deterministic canonical JSON — sorted keys, no whitespace, `None` / `NaN` / `±inf` → `null` | `contract/schemas/v2/README.md` §1 |
| `hash_payload(value)` | SHA-256 hex of `canonicalize_payload(value)` | `contract/schemas/v2/README.md` §1 |
| Pydantic models: `Proof`, `ProofVerificationResult`, `ProofVerificationCheck`, `ConsumeRequest`, `ConsumeResponse` | 1:1 with the v2 schemas | `contract/schemas/v2/*.schema.json` |
| Type aliases: `ProofDecision`, `ProofExecutionStatus`, `ConsumeExecutionStatus`, `ProofVerificationStatus`, `ProofCheckName`, `ProofFailureReason` | Wire-literal string unions | — |

## What's NOT in here

- Any HTTP client code. `verify_proof`, `consume`, `evaluate_batch`,
  streaming subscription — all wait for the v2 server endpoints.
- Any runtime dependency on `atlasent` (v1). The canonicalization
  algorithm is re-implemented here to match
  `atlasent.audit_bundle.canonical_json` byte-for-byte (test:
  `tests/test_canonicalize.py`) so the two can converge at v2 GA
  without a publish-order dependency.

## Relationship to `contract/schemas/v2/`

The schemas are the wire law. Every exported model is a structural
mirror of its schema; the test suite reads the schemas at test time
and asserts that every required schema field is declared on the
pydantic model, so schema ↔ code drift fails CI.

## Relationship to the v1 `canonical_json`

Functionally identical. Kept in two places on purpose — v1 package
is locked at GA and must not take a dependency on this preview;
this preview must not take a runtime dependency on v1 until v2 GA
chooses a consolidation path. `tests/test_canonicalize.py` compares
output against shared vectors so drift surfaces immediately.

## Installation (dev)

```bash
cd python/atlasent_v2_preview
pip install -e '.[dev]'
pytest
```

`atlasent>=1.4.0` is a dev dependency only — it's imported by the
parity test to confirm the v2 canonicalizer matches v1 byte-for-byte.
Runtime users install only `pydantic`.
