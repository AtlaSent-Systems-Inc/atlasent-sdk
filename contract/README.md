# AtlaSent SDK Contract

Canonical definitions for all AtlaSent SDKs. Every SDK **must** implement this contract exactly.

## Contents

| Path | Purpose |
|------|---------|
| `schemas/` | JSON Schema (Draft-07) for every request/response shape |
| `vectors/` | Golden test vectors — SDK test suites should exercise all of these |
| `SDK_COMPATIBILITY.md` | Per-SDK feature parity matrix |
| `drift_detector.py` | Runs the test vectors against a live SDK, reports drift |

## Endpoints

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/v1-evaluate` | POST | `EvaluateRequest` | `EvaluateResponse` |
| `/v1-verify-permit` | POST | `VerifyPermitRequest` | `VerifyPermitResponse` |

## Wire format

- All requests/responses are JSON (`Content-Type: application/json`).
- Authentication: `Authorization: Bearer <api_key>` header.
- All timestamps: ISO-8601 UTC strings.
- `decision` values: `ALLOW`, `DENY`, `HOLD`, `ESCALATE` (uppercase in wire format; SDKs may normalize to lowercase).
