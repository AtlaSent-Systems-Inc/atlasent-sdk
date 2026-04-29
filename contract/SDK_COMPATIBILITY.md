# SDK Compatibility Checklist

One checklist per language. An SDK is "v1-conformant" when every box
is ticked **and** `python contract/tools/drift.py` reports clean
against its source. Negative findings in `drift.py` are blocking.

## Shared (all languages)

- [x] POST `/v1-evaluate` — body matches
      `schemas/evaluate-request.schema.json`.
- [x] POST `/v1-verify-permit` — body matches
      `schemas/verify-permit-request.schema.json`.
- [x] Response parsing: every required field in the response schema
      is read; missing required fields raise a `bad_response` error
      (see `vectors/evaluate.json::evaluate_response_missing_required_fields`).
- [x] A policy DENY (HTTP 200, `permitted: false`) is surfaced as
      data on at least one public entry point; not a transport error.
- [x] Every request carries all headers in `vectors/headers.json`.
- [x] Every request generates a fresh `X-Request-ID`.
- [x] 401 / 403 / 429 / 5xx / timeout / network all map to the
      coarse error codes in `vectors/errors.json`.
- [x] `Retry-After` (seconds or HTTP date) is parsed and exposed on
      rate-limit errors.
- [x] All four evaluate vectors in `vectors/evaluate.json` pass.
- [x] All four verify vectors in `vectors/verify.json` pass.
- [x] All seven error vectors in `vectors/errors.json` pass.

## Python SDK (`python/`) — current state

| Invariant                                       | Status | Notes                                                                 |
|-------------------------------------------------|--------|-----------------------------------------------------------------------|
| Schemas — `EvaluateRequest`                     | OK     | Aliases `action_type→action`, `actor_id→agent`                        |
| Schemas — `EvaluateResult`                      | OK     | Aliases `decision→permitted`, `permit_token→decision_id`              |
| Schemas — `VerifyRequest`                       | OK     | Aliases `permit_token→decision_id`, `action_type→action`, `actor_id→agent` |
| Schemas — `VerifyResult`                        | OK     | Alias `valid→verified`                                                |
| Header: `Authorization: Bearer <key>`           | OK     | `client.py` sets `Authorization: Bearer <api_key>` on the httpx session. |
| Header: `Accept: application/json`              | OK     | Set on the httpx session alongside `Content-Type`.                    |
| Header: `X-Request-ID`                          | OK     | `uuid.uuid4().hex[:12]` per request.                                  |
| Error taxonomy — coarse `code`                  | OK     | All raise sites in `_request()` pass `code=` matching `vectors/errors.json`. |
| Vector: `evaluate_deny_no_throw`                | OK     | `authorize()` returns `permitted=False` on DENY (data, not exception). |
| Vector: `verify_response_missing_verified`      | OK     | `client.verify()` checks for `verified` and raises `code="bad_response"`. |
| Contract vector runner                          | OK     | `python/tests/test_contract_vectors.py` — all vectors pass.           |
| Drift detector                                  | GREEN  | Run by `Contract CI`.                                                 |

### Follow-up work (sized)

_All SDK-PY items landed. No open follow-up._

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

- **SDK-TS-002 — User-Agent format** (XS, optional): the contract
  accepts either `@atlasent/sdk/<semver> node/...` (TS) or
  `atlasent-<lang>/<semver>` (Python). Standardize or keep the
  `headers.json::notes` exception. No code change until decided.

_SDK-TS-001 (contract vector runner) landed —
`typescript/test/contract-vectors.test.ts` is green._

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

## Go SDK (`go/`) — current state

Go SDK skeleton landed in `go/` (2026-04-29). Module:
`github.com/atlasent-systems-inc/atlasent-sdk/go`, Go 1.22,
`github.com/google/uuid` for request IDs.

| Invariant                                       | Status | Notes                                                                 |
|-------------------------------------------------|--------|-----------------------------------------------------------------------|
| Schemas — `EvaluateRequest`                     | OK     | `action`, `agent`, `context` (defaults to `{}`) + `api_key` on wire  |
| Schemas — `VerifyPermitRequest`                 | OK     | `decision_id`, `action`, `agent`, `context`, `api_key` on wire       |
| Response: missing `decision_id` raises error    | OK     | `bad_response` with message containing "permitted or decision_id"     |
| Response: missing `verified` raises error       | OK     | Detected via `*bool` wire field; `bad_response` returned              |
| DENY returned as data (not thrown)              | OK     | `EvaluateResponse.Permitted == false`, no error                       |
| Header: `Authorization: Bearer <key>`           | OK     | `client.go` sets on every `post()` call                               |
| Header: `Accept: application/json`              | OK     |                                                                       |
| Header: `Content-Type: application/json`        | OK     |                                                                       |
| Header: `User-Agent: atlasent-go/<ver> go/...` | OK     | `atlasent-go/1.0.0 go/runtime`                                        |
| Header: `X-Request-ID`                          | OK     | `uuid.NewString()[:12]` — fresh per request                           |
| Error taxonomy — 401/403/429/5xx/timeout/net    | OK     | All map to `AtlaSentError.Code` matching `vectors/errors.json`        |
| `Retry-After` parsed on 429                     | OK     | `parseRetryAfter` handles seconds float and HTTP-date formats         |
| Rate-limit headers parsed                       | OK     | `parseRateLimitHeaders` → `RateLimitState{Limit, Remaining, ResetAt}` |
| `HTTPDoer` interface for test injection         | OK     | `*http.Client` satisfies; test uses `httptest.Server`                 |
| Contract vector runner                          | OK     | `go/client_test.go` — 15 tests, all pass (`go test ./...`)            |
| Trailing-slash normalisation on `BaseURL`       | OK     | `strings.TrimRight(opts.BaseURL, "/")`                                |
| Timeout detection (client `http.Client` + ctx)  | OK     | Checks `ctx.Err()` then `net.Error.Timeout()` → `CodeTimeout`         |

### Follow-up work (sized)

- **SDK-GO-001** — publish: tag `go/v1.0.0`; Go proxy picks it up automatically.
  No workflow needed. Requires human action after PR #121 merges.
- **SDK-GO-002** (post-GA) — Enforce Pack equivalent in `go/enforce/`.
  See `contract/ENFORCE_PACK.md` "Go (post-GA)" note.

## Definition of done

An SDK is done with v1 when:

- every checkbox in its section is ticked, AND
- CI shows `Contract CI` green on the PR that flips the last box.

---

## v2-alpha SDK compatibility

Tracks the `atlasent-v2-alpha` (Py) / `@atlasent/sdk-v2-alpha` (TS)
packages against the `contract/schemas/v2/` wire law. These packages
follow alpha semantics — no semver discipline between alpha releases.
Drift is enforced by `python contract/tools/drift.py` (extended to v2
in the 2.0.0-alpha.1 cycle).

### Shared (both languages — v2)

- [x] `POST /v2/evaluate:batch` — request body matches
      `schemas/v2/evaluate-batch-request.schema.json`; response parsed
      against `evaluate-batch-response.schema.json`. Vectors:
      `contract/vectors/v2/evaluate-batch.json`.
- [x] `POST /v2/permits/:id/consume` — request body matches
      `schemas/v2/consume-request.schema.json`; raw payload NEVER sent,
      only `payload_hash`. Vectors: `contract/vectors/v2/consume.json`.
- [x] `POST /v2/proofs/:id/verify` — response parsed against
      `schemas/v2/proof-verification-result.schema.json`. No request
      body schema (path param only).
- [x] `POST /v2/permits:bulk-revoke` — request body matches
      `schemas/v2/bulk-revoke-request.schema.json`; `revoked_count: 0`
      not thrown. Vectors: `contract/vectors/v2/bulk-revoke.json`.
- [x] Drift detector clean: `python contract/tools/drift.py` reports
      zero drift for both `python-v2` and `typescript-v2` labels.

### v2 Python SDK (`atlasent_v2_alpha`)

| Invariant | Status | Notes |
|-----------|--------|-------|
| Pydantic models match schemas | OK | Verified by drift.py v2 extension |
| `execute` → `executed` status enum | OK | `ConsumeExecutionStatus` |
| `revoker_id` omitted when `None` | OK | Pydantic `exclude_none` on serialize |
| `BulkRevokeResponse.revoked_count: 0` not raised | OK | Returns normally |

### v2 TypeScript SDK (`@atlasent/sdk-v2-alpha`)

| Invariant | Status | Notes |
|-----------|--------|-------|
| Wire interfaces match schemas | OK | Verified by drift.py v2 extension |
| `revoker_id` omitted (not sent as `null`) | OK | Conditional spread in `bulkRevoke` |
| `revoked_count: 0` not thrown | OK | Returns `BulkRevokeResponse` normally |
| camelCase SDK surface → snake_case wire | OK | All body literals use snake_case |

### v2 follow-up work

- [x] **v2-VEC-001** — `contract/vectors/v2/*.json` vectors wired
  into `python/atlasent_v2_alpha/tests/test_contract_vectors.py` (18
  tests) and `typescript/packages/v2-alpha/test/contract-vectors.test.ts`
  (18 tests). `sdk_output` fields corrected to snake_case. All green.
- [x] **v2-SSE-001** — `contract/tools/drift.py` extended to check
  `/v2/decisions:subscribe` SSE envelope fields (`DecisionEvent` model /
  `DecisionEvent` TS interface) against `schemas/v2/decision-event.schema.json`.
  Drift detector reports clean for both `python-v2` and `typescript-v2` labels.
- **v2-PROOF-001** — add `GET /v2/proofs/:id` response vectors once
  the proof system is deployed and a test proof is available.
