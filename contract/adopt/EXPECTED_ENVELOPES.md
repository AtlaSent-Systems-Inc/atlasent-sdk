# Expected envelopes — plain-English reference

The canonical truth is [`../schemas/`](../schemas/). This file is the
**fast reference** for engine implementers who don't want to read JSON
Schema to know what to return. If this document and the schemas ever
disagree, the schemas win.

All bodies are `application/json`, UTF-8, snake_case.

---

## `POST /v1-evaluate`

### Request body

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `action` | string (1..256) | **yes** | Action being authorized. Stable identifier, snake_case recommended. |
| `agent` | string (1..256) | **yes** | Identifier of the calling agent / actor. |
| `context` | object | **yes** | Arbitrary policy context. May be `{}` but MUST be present. JSON-serializable values only. |
| `api_key` | string | **yes** | Echoed in the body for wire parity. Also sent as `Authorization: Bearer <key>`. |

**No additional properties** are permitted (`additionalProperties: false`).

### Response body

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `permitted` | bool | **yes** | `true` = ALLOW, `false` = DENY. |
| `decision_id` | string (non-empty) | **yes** | Opaque permit identifier. Echoed back in `/v1-verify-permit`. |
| `reason` | string | no | Human-readable explanation. MAY be empty on ALLOW. |
| `audit_hash` | string | no | Hash-chained audit-trail entry (GxP / 21 CFR Part 11). |
| `timestamp` | string | no | ISO 8601 (`YYYY-MM-DDTHH:MM:SSZ`). |

Additional properties are **tolerated** (`additionalProperties: true`),
but SDKs do not read them — don't rely on extra fields for behavior.

**Critical**: A DENY is an HTTP 200 with `permitted: false`. It is
**not** a 4xx and **not** an exception. Fail-closed semantics apply
only to failures to *confirm* authorization (network, server error,
malformed body).

---

## `POST /v1-verify-permit`

### Request body

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `decision_id` | string (non-empty) | **yes** | The `decision_id` from a prior `/v1-evaluate`. |
| `action` | string | **yes** | Optional cross-check. MAY be `""`. |
| `agent` | string | **yes** | Optional cross-check. MAY be `""`. |
| `context` | object | **yes** | Optional cross-check. MAY be `{}`. |
| `api_key` | string | **yes** | Same as evaluate. |

No additional properties permitted.

### Response body

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `verified` | bool | **yes** | `true` = permit is valid + un-revoked. |
| `outcome` | string | no | e.g. `"verified"`, `"revoked"`, `"expired"`. |
| `permit_hash` | string | no | Verification hash. |
| `timestamp` | string | no | ISO 8601. |

`verified: false` is also an HTTP 200 — not an error.

---

## Error responses (any non-2xx)

Body SHOULD include `message` (preferred) or `reason`. Both are
surfaced verbatim by SDKs.

| Field | Type | Notes |
|-------|------|-------|
| `message` | string | Preferred human-readable error. |
| `reason` | string | Fallback when `message` is absent. |
| `code` | string | Optional machine-readable (e.g. `"invalid_api_key"`). |
| `request_id` | string | Optional echo of the `X-Request-ID` header. |

### SDK → coarse code mapping

Engines don't need to emit these codes themselves; the mapping is
purely what SDKs surface to callers.

| HTTP status | Transport condition | SDK code |
|-------------|---------------------|----------|
| 401 | — | `invalid_api_key` |
| 403 | — | `forbidden` |
| 429 | — | `rate_limited` (`Retry-After` is parsed) |
| 4xx other | — | `bad_request` |
| 5xx | — | `server_error` |
| — | timeout | `timeout` |
| — | DNS / connect refused | `network` |
| 200 | malformed body | `bad_response` |

---

## Required request headers

Every call carries all five. See [`../vectors/headers.json`](../vectors/headers.json).

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `Accept` | `application/json` |
| `Authorization` | `Bearer <api_key>` |
| `User-Agent` | SDK identifier + semver (format varies per SDK; see contract note) |
| `X-Request-ID` | Fresh per request. UUID v4 recommended. |

Servers MUST accept the API key from `Authorization` **or** from the
body's `api_key` field. New SDKs send both.

---

## Minimal round-trip example

```http
POST /v1-evaluate HTTP/1.1
Host: api.atlasent.io
Content-Type: application/json
Accept: application/json
Authorization: Bearer ask_live_abc123
User-Agent: atlasent-python/1.0.0
X-Request-ID: 6f8ab3c1-4e2b-4c0e-9a5d-7e8f1c2d3a4b

{
  "action": "modify_patient_record",
  "agent": "clinical-data-agent",
  "context": { "user": "dr_smith", "environment": "production" },
  "api_key": "ask_live_abc123"
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "permitted": true,
  "decision_id": "dec_01J8XKQ2",
  "reason": "Operator authorized under GxP policy",
  "audit_hash": "sha256:…",
  "timestamp": "2026-04-17T10:00:00Z"
}
```

---

## If you're implementing the engine

Use the shared test vectors as smoke tests:

- `contract/vectors/evaluate.json` — 4 request/response pairs
- `contract/vectors/verify.json`   — 4 request/response pairs
- `contract/vectors/errors.json`   — 7 HTTP + transport error cases

For every vector, feed `wire_request` to your engine and assert the
response equals `wire_response`. Any SDK that targets contract v1 MUST
pass these, so the engine has no excuse to drift.
