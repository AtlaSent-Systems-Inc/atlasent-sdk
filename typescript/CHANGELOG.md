# Changelog

All notable changes to `@atlasent/sdk` are documented here. The SDK
follows [semver](https://semver.org/): breaking changes bump the major
(or minor while on 0.x).

## 1.2.0 — 2026-04-21

Finishing touches on top of 1.1.0's Python-parity release: framework
guards, structured logging, env-based config. No breaking changes.

### Added

- Framework guards in `src/middleware.ts`:
  - `guard()` — generic higher-order wrapper (any handler signature)
  - `expressGuard()` — Express middleware; calls `next()` on permit,
    `next(err)` on deny / transport error
  - `fastifyGuard()` — Fastify `preHandler` hook
  - All three attach the verified `GateResult` as `req.atlasent` and
    support string or per-request resolvers for `action` / `agent` /
    `context`.
- Structured `Logger` interface + two batteries-included adapters:
  `noopLogger` (default) and `consoleLogger` (JSON lines to stderr).
  Client emits structured fields on evaluate permit/deny, retries,
  and cache hits — pass any `{ debug, info, warn, error }` object to
  route them into pino / winston / Datadog.
- Environment-variable configuration via `fromEnv()`:
  `ATLASENT_API_KEY`, `ATLASENT_BASE_URL`, `ATLASENT_TIMEOUT(_MS)`,
  `ATLASENT_MAX_RETRIES`, `ATLASENT_RETRY_BACKOFF`. Accepts a
  seconds-or-milliseconds dual-unit heuristic for parity with
  Python's `atlasent.config` (values ≤ 600 treated as seconds).
- Module-level `configure()` helper now routes through `fromEnv()`,
  so `ATLASENT_BASE_URL` / `ATLASENT_TIMEOUT` / `ATLASENT_MAX_RETRIES`
  are honored automatically when no explicit options are passed.
- New examples: `examples/authorize-one-call.ts`,
  `examples/gate-with-cache.ts`, `examples/express-middleware.ts`.

### Changed

- `User-Agent` version string now matches `package.json` (was stale
  at `0.1.0`).

### Tests

- 93 tests across 8 files (up from 68). Adds `test/logger.test.ts`
  (6), `test/config.test.ts` (11), `test/middleware.test.ts` (8),
  covering console/noop logger behavior, client log-point assertions,
  env parsing with unit heuristics, and Express/Fastify guard
  permit/deny paths.

## 1.1.0 — 2026-04-21

Python-parity release. See commit `6ae5d66` for the full diff.

### Added

- `AtlaSentClient.gate({ agent, action, context? })` — evaluate +
  verify in one call. Throws `PermissionDeniedError` on deny.
- `AtlaSentClient.authorize({ agent, action, context?, verify?, raiseOnDeny? })`
  — result-based one-call API. Does not throw on deny by default.
- `TTLCache({ ttlMs?, maxSize? })` — in-memory decision cache with
  SHA-256/16-char key derivation byte-compatible with the Python SDK.
- Retry with exponential backoff on 5xx / timeout / network errors.
  Configurable via `maxRetries` / `retryBackoffMs` constructor opts.
- `PermissionDeniedError` extends `AtlaSentError` so a single
  `catch (err: AtlaSentError)` covers both transport and policy
  failures.
- Module-level helpers: `configure`, `authorize`, `gate`, `evaluate`,
  `verifyPermit`, `resetDefaultClient` — backed by a lazily-initialized
  default client (reads `ATLASENT_API_KEY` / `ATLASENT_BASE_URL`).

## 1.0.0 — 2026-04-17

First stable release. Exports one `AtlaSentClient` with two methods
and one flat `AtlaSentError`.

### Added

- `AtlaSentClient.evaluate({ agent, action, context? })` — policy
  decision. Returns `{ decision: "ALLOW" | "DENY", permitId, reason,
  auditHash, timestamp }`. A clean `DENY` is **not** thrown.
- `AtlaSentClient.verifyPermit({ permitId, agent?, action?, context? })`
  — verify a previously-issued permit end-to-end.
- `AtlaSentError` with flat `{ status, code, requestId, retryAfterMs }`.
  `code` is one of `invalid_api_key | forbidden | rate_limited |
  timeout | network | bad_response | bad_request | server_error`.
- Native `fetch`, `AbortSignal.timeout`, `crypto.randomUUID` — zero
  runtime dependencies. Requires Node 20+.
- Standard headers on every request: `Authorization: Bearer <key>`,
  `Accept`, `Content-Type`, `User-Agent`, and a fresh per-request
  `X-Request-ID` for log correlation.
- Wire format: `POST /v1-evaluate` and `POST /v1-verify-permit`. Both
  share the JSON shape in `contract/schemas/`; drift is enforced in
  CI by `contract/tools/drift.py`.

### Tests

- 39 tests across `test/client.test.ts` (20), `test/errors.test.ts`
  (4), and `test/contract-vectors.test.ts` (15). The contract-vector
  suite replays the same golden wire inputs used by the Python SDK,
  guaranteeing cross-language parity.
