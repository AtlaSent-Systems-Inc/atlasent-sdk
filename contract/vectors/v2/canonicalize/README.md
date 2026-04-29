# v2 canonicalization contract vectors — DRAFT

**Status:** DRAFT v2 preview. Fixtures reproduce byte-identically via
`contract/tools/gen_canonicalize_vectors.py`. Regenerate with:

```bash
python contract/tools/gen_canonicalize_vectors.py
```

## What's in here

26 input → expected pairs across five fixture groups, exercising
every rule in the canonicalization spec:

| Fixture | Count | Scenario |
|---|---|---|
| `primitives.json` | 12 | null / bool / int / float / string with quote/escape/unicode |
| `empties.json` | 3 | empty object, empty array, nested empties |
| `key_ordering.json` | 4 | unsorted-key inputs at every depth, including unicode keys |
| `arrays.json` | 4 | order preservation + nested objects/arrays/primitives |
| `realistic_payloads.json` | 3 | Pillar-9-style payload shapes (eval context, deploy payload, nullable fields) |

## Schema

Each fixture file is one JSON object:

```json
{
  "description": "Plain-English summary of what this group locks in.",
  "vectors": [
    { "name": "<short id>", "input": <any JSON value>, "expected": "<canonical JSON bytes>" }
  ]
}
```

`input` is JSON-encoded; consumers parse it with their JSON parser
and feed the parsed value to their canonicalizer. `expected` is the
exact byte sequence the canonicalizer must emit.

## Non-finite numbers

`NaN` / `±Infinity` aren't representable in JSON, so they don't live
on disk here. Both v2-preview SDKs cover them inline in their unit
tests (TS: `test/canonicalize.test.ts`, Python:
`tests/test_canonicalize.py`). Spec rule: all three render as the
string `"null"` — same as `None` / `null`.

## Cross-language users

These fixtures unblock canonicalization parity for any language /
runtime, not just the two SDKs already in this repo:

- **Future Go SDK** — load fixtures, replay, assert byte equality.
- **Server-side reference** in `atlasent-api/_shared/rules.ts` —
  re-running the fixture suite catches drift the same way the v1
  audit-bundle vectors do for `verify.ts`.
- **Regulator-side custom verifiers** — anyone writing a custom
  Pillar 9 verifier can lock onto the same canonicalization without
  importing our SDKs.

Generator deliberately re-uses
`contract/tools/gen_proof_bundles.py::canonical_json` so all v2
canonicalization in the repo flows from one source of truth.
