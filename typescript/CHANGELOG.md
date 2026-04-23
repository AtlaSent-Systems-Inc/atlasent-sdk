# Changelog

All notable changes to `@atlasent/sdk` are documented here. The SDK
follows [semver](https://semver.org/): breaking changes bump the major
(or minor while on 0.x).

## Unreleased

### Added

- **Offline audit-bundle verifier.** `verifyBundle(path, { publicKeysPem })`
  and the lower-level `verifyAuditBundle(bundle, keys)` produce a
  byte-faithful port of `atlasent-api/supabase/functions/v1-audit/verify.ts`.
  Verifies a signed export from `POST /v1/audit/exports` end-to-end:
  per-event SHA-256 hash chain, adjacency, `chain_head_hash` match,
  and Ed25519 signature. Rotation-aware via `signing_key_id`. Runs on
  Node 20+ using `crypto.webcrypto.subtle`; no extra deps. Canonical
  JSON (`canonicalJSON`) and `signedBytesFor` are exported for
  regulator-side custom verifiers.
- Shared test fixtures at `contract/vectors/audit-bundles/` and
  reproducible generator at `contract/tools/gen_audit_bundles.py`.

## 1.3.0 — 2026-04-23

### Added

- **`rateLimit` field on every authed response.** The AtlaSent edge
  functions now emit `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  and `X-RateLimit-Reset` headers on success responses (the 429 path
  with `Retry-After` was already handled). The client parses the
  header triple and surfaces it as a typed `RateLimitState`
  (`{ limit, remaining, resetAt: Date }`) on both
  `EvaluateResponse.rateLimit` and `VerifyPermitResponse.rateLimit`.
  Consumers can preemptively back off instead of waiting for a 429:

      const result = await client.evaluate({ ... });
      if (result.rateLimit && result.rateLimit.remaining < 10) {
        await sleepUntil(result.rateLimit.resetAt);
      }

  `X-RateLimit-Reset` is accepted as either unix-seconds (the
  current server convention) or ISO 8601. `rateLimit` is `null`
  when any of the three headers is missing or unparseable — covers
  older server deployments and internal endpoints that skip
  per-key limits.

- `RateLimitState` type exported from the public entry point for
  consumers building their own back-off logic.

### Non-breaking

Adding `rateLimit: RateLimitState | null` to the response interfaces
is additive. Existing consumers that destructure `{ decision,
permitId, ... }` keep working unchanged. No wire-format change — the
headers have been emitted by the server but previously ignored by
the SDK.

## 1.2.0 — 2026-04-23

### Added

- **`@atlasent/sdk/hono` subpath export — Hono middleware.** Drop-in
  execution-time authorization for any Hono route:

      import { Hono } from "hono";
      import { atlaSentGuard, atlaSentErrorHandler } from "@atlasent/sdk/hono";

      const app = new Hono();
      app.onError(atlaSentErrorHandler());

      app.post(
        "/deploy/:service",
        atlaSentGuard({
          action: (c) => `deploy_${c.req.param("service")}`,
          agent: (c) => c.req.header("x-agent-id") ?? "anonymous",
          context: async (c) => ({ commit: (await c.req.json()).commit }),
        }),
        (c) => c.json({ ok: true, permit: c.get("atlasent") }),
      );

  The guard calls `atlasent.protect()` under the hood — same fail-closed
  semantics. On allow, it stashes the verified `Permit` on the Hono
  context (default key `"atlasent"`, override via `options.key`). On
  deny or transport error it **throws** so you can handle all
  AtlaSent failures in one place via `app.onError`.

- **`atlaSentErrorHandler(options?)` — one-call error mapping.** Maps
  `AtlaSentDeniedError` → 403 and `AtlaSentError` → 503 by default,
  with JSON bodies carrying `decision`, `evaluationId`, `reason`,
  `code`, and `requestId` as appropriate. Customise via `denyStatus`,
  `errorStatus`, `renderDeny`, `renderError`. Non-AtlaSent errors
  re-throw so other `onError` chains still see them.

- **Example**: `examples/hono-guard.ts` — end-to-end `POST /deploy/:service`
  route with the guard and error handler wired up.

### Changed

- `hono` added as an **optional** peer dependency (`^4.0.0`). Users
  who only import the default entry point (`@atlasent/sdk`) don't
  pull it in; users who import `@atlasent/sdk/hono` need `hono`
  installed alongside. Marked optional via `peerDependenciesMeta` so
  package managers don't warn when it's absent.

- `tsup` now builds two entry points (`index`, `hono`) into
  `dist/index.{js,cjs}` + `dist/hono.{js,cjs}` with matching
  `.d.ts` / `.d.cts`. `package.json` `exports` map updated.

### Notes

- Additive. No change to the default-export surface (`atlasent.protect`,
  `atlasent.configure`, `AtlaSentClient`, `AtlaSentError`,
  `AtlaSentDeniedError`). The Hono module re-exports `Permit`,
  `ProtectRequest`, `AtlaSentError`, and `AtlaSentDeniedError` so
  `@atlasent/sdk/hono` is self-contained for callers who only want
  the middleware.
- 9 new tests in `test/hono.test.ts` exercising a real Hono app
  against a mock `fetch`: allow path, function resolvers for
  agent/action/context, deny-throws, custom `key`, skipped
  downstream handler on deny, 403/503 default status mapping,
  custom status + render overrides, and non-AtlaSent error
  re-throw. 63/63 TS tests pass; tsup build + typecheck clean.

## 1.1.0 — 2026-04-22

### Added

- **`atlasent.protect(...)` — the one-call authorization primitive.**
  Fail-closed by construction: on allow, returns a verified `Permit`;
  on deny (or verification failure, transport error, auth error,
  rate limit), throws. There is no `{ permitted: false }` branch to
  forget.

      import atlasent from "@atlasent/sdk";

      const permit = await atlasent.protect({
        agent: "deploy-bot",
        action: "deploy_to_production",
        context: { commit, approver },
      });
      // …execute the action. If we got here, AtlaSent authorized it.

  Internally does `evaluate` → `verifyPermit` in a single call. The
  returned `Permit` carries `permitId`, `permitHash`, `auditHash`,
  `reason`, and `timestamp` so callers can log a full audit trail.

- **Default export** (`import atlasent from "@atlasent/sdk"`) exposing
  `protect`, `configure`, `AtlaSentClient`, `AtlaSentError`, and
  `AtlaSentDeniedError` on a single namespace object — Stripe /
  Auth0 / Supabase style. Named exports remain available for
  advanced callers (`import { AtlaSentClient } from "@atlasent/sdk"`).

- **`atlasent.configure({ apiKey?, baseUrl?, timeoutMs?, fetch? })`.**
  Configures the lazy process-wide client used by `protect`. Optional —
  `protect` also reads `ATLASENT_API_KEY` from the environment.
  Calling `configure` a second time replaces the singleton.

- **`AtlaSentDeniedError`** — dedicated subclass of `AtlaSentError`
  thrown exclusively by `protect` on denial. Carries:
  - `decision: "deny" | "hold" | "escalate"` (forward-compatible
    union; only `"deny"` is emitted against today's API)
  - `evaluationId: string` — the permit / decision id
  - `reason?: string` — policy engine's human-readable explanation
  - `auditHash?: string` — hash-chained audit-trail entry
  - `requestId?: string` — inherited from `AtlaSentError`

  `instanceof AtlaSentError` still catches denials (one exception
  family); use `instanceof AtlaSentDeniedError` to distinguish a
  policy decision from a transport/auth error.

- **`examples/protect.ts`** — canonical quickstart for the new
  primitive.

### Notes

- Additive. No existing export renamed or removed. `AtlaSentClient`,
  the two-method API (`evaluate` / `verifyPermit`), and the
  lowercase/uppercase `EvaluateResponse.decision` contract are all
  unchanged. Existing named-import callers keep working without any
  code change.
- `AtlaSentError.name` is no longer a `readonly` literal — it's a
  mutable string so the new subclass can override it to
  `"AtlaSentDeniedError"`. This is source-compatible for every
  practical use of the property (reading the string).

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
