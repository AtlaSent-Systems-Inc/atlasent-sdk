# Release Notes — v1.0.0

**Release date:** 2026-04-17

## AtlaSent SDK v1.0.0

First stable release of the AtlaSent TypeScript and Python SDKs.

### TypeScript (`@atlasent/sdk`)

- `AtlaSentClient.evaluate({ agent, action, context? })` — policy
  decision. A clean `DENY` is returned in `result.decision`; only
  transport / auth / malformed-response conditions throw.
- `AtlaSentClient.verifyPermit({ permitId, agent?, action?, context? })`
  — confirm a previously-issued permit end-to-end.
- Single error type `AtlaSentError` with a flat `{ status, code,
  requestId, retryAfterMs }` shape. `code` covers `invalid_api_key` /
  `forbidden` / `rate_limited` / `bad_request` / `server_error` /
  `timeout` / `network` / `bad_response`.
- Native `fetch` + `AbortSignal.timeout`, zero runtime dependencies,
  Node 20+.
- `Authorization: Bearer <key>`, `X-Request-ID`, `User-Agent`, and
  `Accept` headers on every request; request body uses the shared
  contract wire format (`/v1-evaluate`, `/v1-verify-permit`).

### Python (`atlasent`)

- `authorize(agent, action, context, verify, raise_on_deny)` — the
  Stripe-style one-call entrypoint; returns an `AuthorizationResult`.
- `AtlaSentClient` / `AsyncAtlaSentClient` — sync and async variants
  with feature parity: `evaluate`, `verify`, `gate`, `authorize`.
- `@atlasent_guard` / `@async_atlasent_guard` decorators — wrap any
  function; raise `AuthorizationError` on deny.
- Typed errors (`AtlaSentError` with `code`, `AtlaSentDenied`,
  `PermissionDeniedError`, `RateLimitError`, `ConfigurationError`) —
  `AtlaSentErrorCode` Literal matches the TS taxonomy.
- `TTLCache` — opt-in in-process cache for hot-path evaluations.
- Configurable retry with exponential backoff on 5xx and timeouts.

### Shared contract

Both SDKs target the same endpoints and wire shapes:

- `POST https://api.atlasent.io/v1-evaluate`
- `POST https://api.atlasent.io/v1-verify-permit`

Canonical schemas and golden vectors live in
[`contract/`](./contract/). `contract/tools/drift.py` enforces that
both SDKs serialize requests identically.

### Breaking changes from pre-release

None — this is the first stable release. Pre-release users should pin
to `>=1.0.0,<2.0.0`.

### Upgrade notes

```bash
npm install @atlasent/sdk@1.0.0
pip install atlasent==1.0.0
```

### Stability guarantees

All public exports in `typescript/src/index.ts` /
`python/atlasent/__init__.py` are stable as of v1.0.0. Internal
modules are not part of the public API.
