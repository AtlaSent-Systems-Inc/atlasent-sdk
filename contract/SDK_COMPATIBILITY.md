# SDK Compatibility Checklist

One checklist per language. An SDK is "v1-conformant" when every box
is ticked **and** `python contract/tools/drift.py` reports clean
against its source. Negative findings in `drift.py` are blocking.

## Shared (all languages)

- [ ] POST `/v1-evaluate` — body matches
      `schemas/evaluate-request.schema.json`.
- [ ] POST `/v1-verify-permit` — body matches
      `schemas/verify-permit-request.schema.json`.
- [ ] Response parsing: every required field in the response schema
      is read; missing required fields raise a `bad_response` error
      (see `vectors/evaluate.json::evaluate_response_missing_required_fields`).
- [ ] A policy DENY (HTTP 200, `permitted: false`) is surfaced as
      data on at least one public entry point; not a transport error.
- [ ] Every request carries all headers in `vectors/headers.json`.
- [ ] Every request generates a fresh `X-Request-ID`.
- [ ] 401 / 403 / 429 / 5xx / timeout / network all map to the
      coarse error codes in `vectors/errors.json`.
- [ ] `Retry-After` (seconds or HTTP date) is parsed and exposed on
      rate-limit errors.
- [ ] All four evaluate vectors in `vectors/evaluate.json` pass.
- [ ] All four verify vectors in `vectors/verify.json` pass.
- [ ] All seven error vectors in `vectors/errors.json` pass.

## Python SDK (`python/`) — current state

| Invariant                                       | Status | Notes                                                                 |
|-------------------------------------------------|--------|-----------------------------------------------------------------------|
| Schemas — `EvaluateRequest`                     | OK     | Aliases `action_type→action`, `actor_id→agent`                        |
| Schemas — `EvaluateResult`                      | OK     | Aliases `decision→permitted`, `permit_token→decision_id`              |
| Schemas — `VerifyRequest`                       | OK     | Aliases `permit_token→decision_id`, `action_type→action`, `actor_id→agent` |
| Schemas — `VerifyResult`                        | OK     | Alias `valid→verified`                                                |
| Header: `Authorization: Bearer <key>`           | **MISSING** | `client.py` sets Content-Type + User-Agent only; `api_key` appears in body only. Follow-up branch required. |
| Header: `Accept: application/json`              | **MISSING** | Add to session headers.                                               |
| Header: `X-Request-ID`                          | OK     | `uuid.uuid4().hex[:12]` per request.                                  |
| Error taxonomy — coarse `code`                  | **PARTIAL** | `AtlaSentError` carries `status_code` + `response_body` but no string `code`. |
| Vector: `evaluate_deny_no_throw`                | **DIFFERS** | `client.evaluate()` raises `AtlaSentDenied` on DENY; the contract's public `authorize()` surfaces DENY as data. Keep `evaluate()` as fail-closed, but `authorize()` MUST return data on DENY (already does). |
| Vector: `verify_response_missing_verified`      | NEEDS TEST | Add a test that mocks a response missing `verified` and asserts `bad_response`-shaped error. |
| Drift detector                                  | GREEN  | Run by `Contract CI`.                                                 |

### Follow-up work (sized)

- **SDK-PY-001 — headers parity** (S, 1 commit): add
  `Authorization`, `Accept` on the `httpx.Client` headers. Mirror in
  `async_client.py`.
- **SDK-PY-002 — coarse error code** (M, 1 commit): introduce an
  `AtlaSentErrorCode = Literal["invalid_api_key", "forbidden",
  "rate_limited", "timeout", "network", "bad_response", "bad_request",
  "server_error"]` and a `code: AtlaSentErrorCode | None` attribute on
  `AtlaSentError`. Set it at every raise site in `client._post` and
  `async_client._post`.
- **SDK-PY-003 — bad_response error** (S, 1 commit): raise a
  dedicated `code="bad_response"` when the server returns a
  valid-JSON body that is missing `permitted` / `decision_id` /
  `verified`. Currently pydantic raises a generic `ValidationError`.
- **SDK-PY-004 — contract vector runner** (M, 1 commit): add
  `python/tests/test_contract_vectors.py` that loads
  `contract/vectors/*.json` and asserts each vector's `sdk_input` →
  `wire_request` and `wire_response` → `sdk_output` round-trip
  against the live Python SDK (with httpx mocked).

## TypeScript SDK (`typescript/`) — current state

| Invariant                                       | Status | Notes                                                                 |
|-------------------------------------------------|--------|-----------------------------------------------------------------------|
| Schemas — wire body                             | OK     | `client.ts::evaluate` and `verifyPermit` emit all required fields.    |
| Schemas — wire response interfaces              | OK     | `EvaluateWire`, `VerifyPermitWire` read the right keys.               |
| Header: `Authorization: Bearer <key>`           | OK     |                                                                       |
| Header: `Accept: application/json`              | OK     |                                                                       |
| Header: `X-Request-ID`                          | OK     | `crypto.randomUUID()` per request.                                    |
| Error taxonomy — coarse `code`                  | OK     | `AtlaSentErrorCode` matches `vectors/errors.json`.                    |
| DENY returned as data (not thrown)              | OK     | `client.test.ts::returns decision: DENY...`                           |
| Vector: `evaluate_response_missing_required_fields` | OK | `client.test.ts::JSON object missing required evaluate fields...`   |

### Follow-up work (sized)

- **SDK-TS-001 — contract vector runner** (S, 1 commit): add
  `typescript/test/contract-vectors.test.ts` that reads
  `contract/vectors/evaluate.json` + `verify.json` and asserts
  round-trip parity via mocked fetch. Vectors ship in the repo, so no
  extra deps.
- **SDK-TS-002 — User-Agent format** (XS, 1 commit, optional): the
  contract currently accepts either `@atlasent/sdk/<semver> node/...`
  (TS today) or `atlasent-<lang>/<semver>` (Python today). Either we
  standardize on one shape or keep `headers.json::notes` as the
  permanent exception. No code change until that decision is made.

## Follow-up branch plan

Proposed sequence (one branch per bullet; all branch off `main`, all
target `main`):

1. `claude/py-sdk-headers-parity` — SDK-PY-001. Small, safe, self-
   contained.
2. `claude/py-sdk-error-code` — SDK-PY-002 + SDK-PY-003. Adds a new
   public attribute; semver minor bump (Python 0.4.0).
3. `claude/py-sdk-contract-vectors` — SDK-PY-004. Wires the shared
   vectors into the Python test suite.
4. `claude/ts-sdk-contract-vectors` — SDK-TS-001.

Each of those branches will ONLY touch its language subtree plus the
vectors it consumes — the shared contract in `contract/` is frozen
until a contract change is justified on its own branch.

## Definition of done

An SDK is done with v1 when:

- every checkbox in its section is ticked, AND
- CI shows `Contract CI` green on the PR that flips the last box.
