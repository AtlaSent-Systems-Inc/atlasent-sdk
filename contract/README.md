# AtlaSent SDK Contract (v1)

Single source of truth for the AtlaSent authorization API — what every
SDK **must** send, accept, and surface to its caller. If it isn't
written down here, it isn't part of the contract.

```
contract/
├── schemas/                     # JSON Schemas — the wire-format law
│   ├── evaluate-request.schema.json
│   ├── evaluate-response.schema.json
│   ├── verify-permit-request.schema.json
│   ├── verify-permit-response.schema.json
│   ├── error-response.schema.json
│   └── policy.schema.json       # AtlaSent policy document format
├── vectors/                     # Machine-readable test vectors
│   ├── evaluate.json            # Round-trip for POST /v1-evaluate
│   ├── verify.json              # Round-trip for POST /v1-verify-permit
│   ├── errors.json              # HTTP + transport error mapping
│   ├── headers.json              # Required request headers
│   └── policies/                # Positive + negative policy fixtures
├── adopt/                       # Drop-in kit for non-SDK consumers
│   ├── validate_response.py     # CLI: validate a body against a schema
│   ├── validate-against-atlasent-contract.yml  # GH Actions workflow
│   ├── EXPECTED_ENVELOPES.md    # Plain-English request/response ref
│   └── README.md                # Vendoring + integration guide
├── openapi.yaml                 # OpenAPI 3.1 doc wrapping the schemas above
├── tools/
│   ├── drift.py                 # SDK ↔ contract drift detector
│   ├── policy_lint.py           # Validates policies against schema
│   ├── validate_openapi.py      # Validates openapi.yaml + syncs with schemas
│   └── validate_vectors.py      # Validates vectors against schemas
├── tests/
│   └── test_contract.py         # One-command pytest entry point
├── requirements.txt
└── SDK_COMPATIBILITY.md         # Per-SDK conformance checklist
```

## Two endpoints, forever

Every SDK targets exactly:

| Method | Path                | Body schema                               | Response schema                              |
|--------|---------------------|-------------------------------------------|----------------------------------------------|
| POST   | `/v1-evaluate`      | `evaluate-request.schema.json`            | `evaluate-response.schema.json`              |
| POST   | `/v1-verify-permit` | `verify-permit-request.schema.json`       | `verify-permit-response.schema.json`         |

Wire encoding: `application/json`, UTF-8, snake_case keys. SDKs MAY
expose camelCase on their public surface (TypeScript does), but the
bytes on the wire MUST match the schema verbatim.

## The five invariants

1. **Fail-closed.** Any failure to *confirm* authorization raises /
   throws. A clean DENY (`permitted: false`, HTTP 200) is returned as
   data — not an error.
2. **Same two endpoints everywhere.** No language ships a helper that
   talks to a third path.
3. **Wire parity.** A permit issued via SDK A must verify via SDK B
   against the same server.
4. **Required request headers.** See `vectors/headers.json`.
   `Authorization: Bearer <key>` **and** `api_key` in the JSON body —
   both, always.
5. **Error taxonomy.** Every SDK's error type carries `status` +
   coarse `code` (or equivalent) from the set in
   `vectors/errors.json`.

## Running the contract suite locally

```bash
pip install -r contract/requirements.txt
pip install -e python/

python contract/tools/validate_vectors.py   # vectors vs schemas
python contract/tools/validate_openapi.py   # openapi.yaml vs schemas
python contract/tools/policy_lint.py        # policies vs policy schema
python contract/tools/drift.py              # Python + TS SDK vs schemas

pytest contract/tests/ -v                   # all of the above
```

CI runs the same five commands in `.github/workflows/contract-ci.yml`.
The workflow is path-filtered to the contract dir plus the two SDK
files it introspects (`python/atlasent/models.py`,
`typescript/src/client.ts`, `typescript/src/types.ts`).

## The OpenAPI document

[`openapi.yaml`](./openapi.yaml) is an OpenAPI 3.1 document that wraps
the JSON Schemas above into a single machine-readable artifact. It
exists so downstream consumers have one file to point at:

- pydantic model codegen (`datamodel-code-generator`) for the Python
  SDK and any server-side Python client,
- `@atlasent/types` package (when published),
- Redoc / Stoplight / Postman / Insomnia collections,
- non-SDK adopters who want a full API spec rather than individual
  `$ref`s to the schemas.

**The JSON Schemas under `schemas/` remain the source of truth.** If
`openapi.yaml` and a JSON Schema disagree, the JSON Schema wins — the
SDK drift detector introspects from the schemas, not from the OpenAPI
doc. `tools/validate_openapi.py` asserts that the component schemas
in `openapi.yaml` stay in sync with their JSON Schema counterparts
(required properties, property names, top-level `type` and
`additionalProperties` all match exactly) and runs in CI on every
contract change.

Scope today: `/v1-evaluate` and `/v1-verify-permit` — the two
endpoints the SDKs currently target. Streaming evaluate, the offline
audit-bundle format, and the remaining endpoints (sessions, audit/*,
approvals, overrides, permits/*) each need a server-side spec before
they can be added; see [`../docs/V1_PLAN.md`](../docs/V1_PLAN.md) for
the roadmap.

## How drift detection works

The detector imports each SDK and introspects its wire-format shape:

- **Python**: pydantic `model_fields` with aliases. `EvaluateRequest`,
  `EvaluateResult`, `VerifyRequest`, `VerifyResult` are the
  contract-bearing types; their serialized key set MUST equal the
  schema's required set and MUST be a subset of the schema's allowed
  set.
- **TypeScript**: the `const body = { ... }` literals inside
  `evaluate()` and `verifyPermit()`, plus the `EvaluateWire` /
  `VerifyPermitWire` interfaces. Same comparison rules.

If either SDK strays — renames a field, drops a header, adds a stray
property — CI fails before the drift ships.

## How policy linting works

`tools/policy_lint.py` validates every `*.json` under
`vectors/policies/` against `schemas/policy.schema.json` and applies
small semantic checks (duplicate rule IDs, empty rule lists). Files
named `INVALID_*.json` are *negative fixtures*: the linter expects
them to fail, and flips its outcome accordingly. This keeps the
schema honest — if the schema is accidentally relaxed so that an
`INVALID_*` file starts passing, CI fails.

## Adding / changing the contract

1. Edit the schema(s) in `contract/schemas/`.
2. Add or update vectors in `contract/vectors/` to cover the change.
3. Run the suite locally; fix any drift in the SDKs.
4. Open a PR. `Contract CI` runs automatically.
5. Bump the `$id` version (`/contract/v1/` → `/contract/v2/`) ONLY
   for a breaking wire change; otherwise the contract stays on v1.

## For non-SDK consumers (engine, downstream repos)

If you're **producing** or **consuming** AtlaSent envelopes but don't
ship an SDK yourself — the policy engine, an integration harness, a
partner adapter — use [`adopt/`](./adopt/README.md). It gives you a
single-file CLI validator, a drop-in GitHub Actions workflow, and a
plain-English reference for the required envelopes. You don't need
to read the schemas to be compliant.

## Related

- [`adopt/README.md`](./adopt/README.md) — adopter kit (vendoring +
  CI recipe for engines and downstream repos).
- [`SDK_COMPATIBILITY.md`](./SDK_COMPATIBILITY.md) — per-SDK
  conformance checklist (Python, TypeScript, and any future client).
