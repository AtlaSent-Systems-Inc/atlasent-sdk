# `atlasent-v2-alpha`

Alpha release of the v2 AtlaSent SDK for Python.

> **Status: alpha.** Surfaces are usable and tested, but the API is
> subject to change between alpha releases as the v2 wire contract
> stabilises. Pin to an exact version (`atlasent-v2-alpha==2.0.0a0`)
> if you depend on this package from production code.

Python sibling of
[`@atlasent/sdk-v2-alpha`](../../typescript/packages/v2-alpha/).
Same scope, same parity invariants — the Pillar 9 (Verifiable Proof
System) primitives that have no server dependency, plus the v2 wire
models.

## Why a separate package?

1. `atlasent` (v1) is on PyPI and locked at GA — it MUST NOT regress.
2. A net-new package gives us room to iterate on the Pillar 9
   canonicalization algorithm, proof envelope shape, and callback
   lifecycle without touching the v1 surface in `python/atlasent/`.
3. Adopters can `pip install atlasent-v2-alpha` alongside v1 and
   start wiring against the v2 utilities today, with the explicit
   understanding that minor v2-alpha versions may break things.

## What's in here

| Export | Purpose |
|---|---|
| `canonicalize_payload(value)` | Deterministic canonical JSON — sorted keys, no whitespace, `None` / `NaN` / `±inf` → `null` |
| `hash_payload(value)` | SHA-256 hex of `canonicalize_payload(value)` |
| Pydantic models: `Proof`, `ProofVerificationResult`, `ProofVerificationCheck`, `ConsumeRequest`, `ConsumeResponse` | 1:1 with the v2 schemas |
| Type aliases: `ProofDecision`, `ProofExecutionStatus`, `ConsumeExecutionStatus`, `ProofVerificationStatus`, `ProofCheckName`, `ProofFailureReason` | Wire-literal string unions |

## What's coming next (tracked in subsequent PRs)

- `consume()` + `verify_proof()` — HTTP methods (PR2)
- `evaluate_batch()` — batched evaluate over `/v2-evaluate-batch` (PR3)
- `subscribe_decisions()` — SSE-based decision-event stream (PR4)

## Relationship to `contract/schemas/v2/`

The schemas are the wire law. Every exported model is a structural
mirror of its schema; the test suite reads the schemas at test time
and asserts that every required schema field is declared on the
pydantic model, so schema ↔ code drift fails CI.

## Relationship to the v1 `canonical_json`

Functionally identical. Kept in two places on purpose — v1 package
is locked at GA and must not take a runtime dependency on this
alpha; this alpha must not take a runtime dependency on v1 until
v2 GA chooses a consolidation path. `tests/test_canonicalize.py`
compares output against shared vectors so drift surfaces immediately.

## Installation

```bash
pip install atlasent-v2-alpha
```

For local development:

```bash
cd python/atlasent_v2_alpha
pip install -e '.[dev]'
pytest
```

`atlasent>=1.4.0` is a dev dependency only — it's imported by the
parity test to confirm the v2 canonicalizer matches v1 byte-for-byte.
Runtime users install only `pydantic` + `cryptography`.
