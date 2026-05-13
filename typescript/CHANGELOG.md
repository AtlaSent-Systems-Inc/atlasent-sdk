# Changelog

All notable changes to `@atlasent/sdk` are documented here. The SDK
follows [semver](https://semver.org/): breaking changes bump the major
(or minor while on 0.x).

## 0.1.0 — 2026-05-13

First public release. Locks the V1 execution-time authorization runtime surface.

> **Scope:** This release covers evaluate, permit verification, streaming evaluation, and offline bundle verification. It is a stabilization tag, not a completeness tag — additional endpoints and type-source-of-truth migration are tracked for the next release cycle.

### Core runtime surface

- **`AtlaSentClient.evaluate({ agent, action, context? })`** — policy decision via `POST /v1-evaluate`. Returns `{ decision: "ALLOW" | "DENY", permitId, reason, auditHash, timestamp }`. A clean `DENY` is not thrown.
- **`AtlaSentClient.verifyPermit({ permitId, agent?, action?, context? })`** — end-to-end permit verification via `POST /v1-verify-permit`. Returns `{ verified, outcome, permitHash, timestamp }`.
- **`AtlaSentClient.evaluateStream({ agent, action, context? })`** — async generator yielding `EvaluateStreamEvent` objects over SSE from `POST /v1-evaluate-stream`. Event types: `"reasoning"`, `"policy_check"`, `"decision"`. A `DENY` decision is yielded, not thrown.
- **`verifyBundle(path)`** — offline Ed25519 audit bundle verifier (imported from `@atlasent/sdk`). No network call. Returns `{ valid, eventCount, publicKey, error }`. Uses Node's built-in `crypto.subtle` — no additional dependencies.

### Error handling

- `AtlaSentError` with flat `{ status, code, requestId, retryAfterMs }`.
- `code` values: `invalid_api_key | forbidden | rate_limited | timeout | network | bad_response | bad_request | server_error`.
- Every error carries `requestId` — the per-request UUID sent as `X-Request-ID`.

### Design

- Fail-closed: `DENY` is returned; every other failure throws.
- Native `fetch`, `AbortSignal.timeout`, `crypto.randomUUID` — zero runtime npm dependencies.
- Bearer-token auth (`Authorization: Bearer <apiKey>`).
- `Accept: text/event-stream` on streaming requests; `Accept: application/json` otherwise.

### Packaging

- Node.js 20+ required.
- TypeScript 5.0+ for best ergonomics; plain interfaces are compatible with older compilers.
- `"type": "module"` with dual CJS/ESM output via tsup.
- npm provenance attestation on publish (Sigstore, `--provenance` flag).
- Apache-2.0 license.

### Tests

- 64 tests across `client.test.ts` (20), `errors.test.ts` (4), `contract-vectors.test.ts` (15), `stream.test.ts` (12), `audit.test.ts` (13).
- Contract-vector suite replays the same golden wire inputs used by the Python SDK, guaranteeing cross-language wire parity.

### Not included in 0.1.0

Deferred to a future release:

- `POST /v1-session`, `GET/POST /v1-audit/events`, `GET /v1-audit/exports`, `POST /v1-audit/verify`
- `POST /v1-approvals`, `POST /v1-overrides`, `POST /v1-permits/consume`, `POST /v1-permits/revoke`
- Importing types from `@atlasent/types` (types are currently defined locally in `src/types.ts`)
