# Changelog

All notable changes to `@atlasent/sdk` are documented here. The SDK
follows [semver](https://semver.org/): breaking changes bump the major
(or minor while on 0.x).

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
