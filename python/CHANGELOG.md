# Changelog

## 1.3.0 — 2026-04-23

### Added

- **`rate_limit` field on every authed response.** The AtlaSent edge
  functions now emit `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  and `X-RateLimit-Reset` headers on success responses (the 429 path
  with `Retry-After` was already handled). The client parses the
  header triple and surfaces it as a typed `RateLimitState` dataclass
  (`limit: int`, `remaining: int`, `reset_at: datetime`) on both
  `EvaluateResult.rate_limit` and `VerifyResult.rate_limit`. Clients
  can preemptively back off instead of waiting for a 429:

      from datetime import datetime, timezone
      import time

      result = client.evaluate("deploy", "ci-bot")
      if result.rate_limit and result.rate_limit.remaining < 10:
          delay = (
              result.rate_limit.reset_at - datetime.now(timezone.utc)
          ).total_seconds()
          if delay > 0:
              time.sleep(delay)

  `X-RateLimit-Reset` is accepted as either unix-seconds (the
  current server convention) or ISO 8601. `rate_limit` is `None`
  when any of the three headers is missing or unparseable — covers
  older server deployments and internal endpoints that skip
  per-key limits.

- `RateLimitState` exported from the top-level `atlasent` namespace
  for consumers building their own back-off logic.

- Works identically on both `AtlaSentClient` and
  `AsyncAtlaSentClient`; the header parser is shared.

### Non-breaking

Adding `rate_limit: RateLimitState | None` to `EvaluateResult` and
`VerifyResult` is additive. Existing attribute access
(`result.decision`, `result.permit_token`, etc.) is unchanged. No
wire-format change — the headers have been emitted by the server
but previously ignored by the SDK.

## 1.2.0 — 2026-04-23

### Added

- **`AtlaSentError.request_id`.** Every SDK-raised exception now
  carries the `X-Request-ID` the client sent with the failing
  request. Paste it into support tickets to correlate with
  server-side log entries. The attribute is populated on every
  raise site — transport errors, HTTP-status errors,
  `RateLimitError`, `AtlaSentDenied`, and the post-response
  malformed-body `bad_response` check — so call sites can rely on
  it without defensive `getattr`:

      try:
          result = authorize(...)
      except AtlaSentError as err:
          log.error("atlasent call failed rid=%s code=%s",
                    err.request_id, err.code)

  The TypeScript SDK already exposed `requestId` on `AtlaSentError`;
  this closes the Python parity gap.

- **`Retry-After` now accepts the HTTP-date form** in addition to
  numeric delta-seconds, per RFC 9110 §10.2.3. Previously,
  `RateLimitError.retry_after` silently became `None` when the
  server sent a date like `"Wed, 21 Oct 2026 07:28:00 GMT"`,
  causing retry-pacing code to skip the back-off. Now both forms
  are parsed; dates in the past are clamped to `0.0`.

### Changed

- `AtlaSentClient._post` / `AsyncAtlaSentClient._post` now return
  `(body, request_id)` instead of `body`. This is an internal
  signature; no public API change. It lets the `evaluate` /
  `verify` shape-check raise sites thread `request_id` into the
  exception they raise after `_post` returns, so those exceptions
  now carry the same correlation id as the transport-level ones.

### Notes

- Additive only — no field renames, no removed exports, no wire
  format change. Drop-in for 1.1.0 callers.

## 1.1.0 — 2026-04-23

### Added

- **`atlasent.protect(...)` — the one-call authorization primitive.**
  Fail-closed by construction: on allow, returns a verified `Permit`;
  on deny (or verification failure, transport error, auth error,
  rate limit), raises. There is no `permitted=False` return path to
  forget.

      from atlasent import protect

      permit = protect(
          agent="deploy-bot",
          action="deploy_to_production",
          context={"commit": commit, "approver": approver},
      )
      # …execute the action. If we got here, AtlaSent authorized it.

  Internally does `evaluate` → `verify_permit` in a single call and
  returns a `Permit` carrying `permit_id`, `permit_hash`, `audit_hash`,
  `reason`, and `timestamp`. Matches the TypeScript SDK's
  `atlasent.protect()` for cross-language parity.

  Available as:
  - Module-level: `atlasent.protect(...)` using the globally
    configured client (same env-var / `configure()` story as
    `authorize()`).
  - Method: `AtlaSentClient.protect(...)` and
    `AsyncAtlaSentClient.protect(...)`.

- **`Permit` dataclass** — the return type of `protect()`. Frozen
  dataclass with `permit_id`, `permit_hash`, `audit_hash`, `reason`,
  `timestamp`. Mirrors the TypeScript SDK's `Permit` interface.

- **`AtlaSentDeniedError`** — new exception raised exclusively by
  `protect()` on policy denial or permit-verification failure.
  Subclass of the existing `AtlaSentDenied`, so
  `except AtlaSentDenied:` still catches `protect()` denials;
  use `except AtlaSentDeniedError:` to distinguish a `protect()`
  denial from the older `authorize()` / `evaluate()` denial surface.

  Attributes:
  - `decision: "deny" | "hold" | "escalate"` — forward-compatible
    union; only `"deny"` is emitted against today's API
  - `evaluation_id: str` — opaque decision id (also available as
    the inherited `permit_token` for backward compat)
  - `reason: str` — policy engine's explanation
  - `audit_hash: str` — hash-chained audit-trail entry
  - `request_id: str | None` — correlation id, when available

- **`AtlaSentDecision` type alias** — `Literal["deny", "hold",
  "escalate"]`, exported for type-checked `match` statements.

- **`examples/protect.py`** — canonical quickstart showing error
  handling for both `AtlaSentDeniedError` and `AtlaSentError`.

### Notes

- Additive. No existing export renamed or removed. `authorize()`,
  `evaluate()`, `verify()`, `gate()`, `AtlaSentClient`, and all
  existing error types keep working unchanged. `protect()` is the
  new recommended entry point; `authorize()` remains supported for
  callers who prefer the data-not-exception branching idiom.
- 17 new tests in `tests/test_protect.py` covering sync + async
  clients, module-level shortcut, allow path, policy-deny,
  verify-revoked, transport-error propagation, payload shape, and
  the `AtlaSentDeniedError` class itself. 167 / 167 tests pass.

## 1.0.0 — 2026-04-17

First stable release. Public exports in `atlasent/__init__.py` are
the supported v1 surface; pin to `>=1.0.0,<2.0.0`.

### Added

- Cross-language `RELEASE_NOTES.md` covering the v1.0.0 surface for
  both `atlasent` and `@atlasent/sdk`.
- Trusted-publishing PyPI release workflow (PEP 740 attestations,
  no API token required).
- Contract drift detector (`contract/tools/drift.py`) wired into CI
  to enforce wire-shape parity with the TypeScript SDK on every PR.
- Gated staging integration suite (skips cleanly when
  `STAGING_ATLASENT_API_KEY` is absent so fork PRs stay green).
- Coverage floor of 88% on the `atlasent` package, enforced in CI.

### Notes

- No public API changes from 0.4.0 — same `authorize()`, client
  classes, decorators, error taxonomy, and wire format. The bump to
  1.0.0 marks API stability, not new surface.
- `AtlaSentErrorCode` Literal and the `bad_response` raise sites
  added in 0.4.0 are now part of the stable contract.

## 0.4.0 — 2026-04-17

### Added

- **Coarse `code` attribute on `AtlaSentError`.** New
  `AtlaSentErrorCode` Literal (`"invalid_api_key" | "forbidden" |
  "rate_limited" | "timeout" | "network" | "bad_response" |
  "bad_request" | "server_error"`) aligned with the shared SDK
  contract. Every raise site in `client._post` / `async_client._post`
  sets it, and `RateLimitError` is pre-populated with
  `code="rate_limited"`. Lets call sites `match err.code:` rather
  than regex the message:

      try:
          result = authorize(...)
      except RateLimitError as err:
          ...  # err.code == "rate_limited"
      except AtlaSentError as err:
          if err.code == "invalid_api_key":
              ...

- **Dedicated `bad_response` errors for malformed bodies.** When the
  server returns HTTP 200 with valid JSON that is missing
  `permitted` / `decision_id` (evaluate) or `verified` (verify), the
  SDK now raises `AtlaSentError(code="bad_response", response_body=…)`
  instead of a generic pydantic `ValidationError`. Matches the
  TypeScript SDK and the `evaluate_response_missing_required_fields`
  /  `verify_response_missing_verified` contract vectors.

### Notes

- This is an additive minor bump — no existing attribute changes
  type. The new `code` field on `AtlaSentError` defaults to `None`
  for user-constructed errors; all SDK-internal raise sites set it.

## 0.3.0 — 2026-04-16

### Added

- **`authorize()` — the one-call public API.** Stripe-style entrypoint:

      from atlasent import authorize

      result = authorize(
          agent="clinical-data-agent",
          action="modify_patient_record",
          context={"user": "dr_smith", "environment": "production"},
      )
      if result.permitted:
          ...

  Available as a top-level function (using the global config) and as a
  method on both `AtlaSentClient` and `AsyncAtlaSentClient`.
- **`AuthorizationResult` dataclass** — the return type of `authorize()`.
  Exposes `permitted`, `reason`, `permit_token`, `audit_hash`,
  `permit_hash`, `verified`, `timestamp`, `agent`, `action`, `context`,
  and `raw`. Truthy when permitted, so `if authorize(...):` works.
- **`PermissionDeniedError`** — subclass of `AtlaSentDenied`, raised by
  `authorize(..., raise_on_deny=True)` for fail-closed call sites that
  prefer exceptions on denial.
- **`verify=False` opt-out** — skip the `/v1-verify-permit` round-trip
  when the caller doesn't need an end-to-end verified permit.

### Changed

- `authorize()` returns `permitted=False` on a clean policy denial
  rather than raising — the caller branches on `result.permitted`.
  Network, configuration, and rate-limit failures still raise (the
  SDK remains fail-closed).
- README rewritten to lead with `authorize()`; `evaluate()` / `verify()`
  / `gate()` are now documented as lower-level primitives.
- `examples/clinical_data_agent.py`, `examples/basic_authorize.py`,
  `examples/fastapi_integration.py`, `examples/flask_integration.py`
  rewritten to use `authorize()`.
- `.env.example` documents both `ATLASENT_API_KEY` and
  `ATLASENT_ANON_KEY`.
- Version bumped to 0.3.0.

### Tests

- 22 new tests covering the dataclass, sync + async client methods,
  global-config wrapper, deny / `raise_on_deny`, network and 429 paths,
  payload shape, and the documented quickstart idiom (112 total).

## 0.2.0 — 2025-04-16

### Added

- **`atlasent_guard` / `async_atlasent_guard` decorators** — gate any
  function behind AtlaSent authorization with a single decorator. Supports
  dynamic actor IDs and context from function kwargs.
- **Structured JSON logging** — `atlasent.logging.configure_logging()` sets
  up the ``atlasent`` logger with a JSON formatter suitable for SIEM/CloudWatch.
  Includes ``timestamp``, ``level``, ``logger``, ``message``, and optional
  fields: ``action_type``, ``actor_id``, ``permit_token``, ``request_id``.
- **TTLCache** — in-memory TTL cache for evaluate results. Pass
  ``cache=TTLCache(ttl=30)`` to ``AtlaSentClient`` to avoid redundant
  API calls for identical (action, actor, context) tuples.
- **Request ID correlation** — every HTTP request now includes an
  ``X-Request-ID`` header (UUID-based) for end-to-end tracing.

### Changed

- ``AtlaSentClient`` and ``AsyncAtlaSentClient`` now accept an optional
  ``cache`` parameter.
- Version bumped to 0.2.0.

## 0.1.0 — 2025-01-15

Initial release of the AtlaSent Python SDK.

### Core

- **Fail-closed design** — `evaluate()` raises `AtlaSentDenied` on deny; any
  network or config failure raises `AtlaSentError`. No action proceeds without
  an explicit permit.
- **Three methods**: `evaluate(action_type, actor_id, context)`,
  `verify(permit_token, ...)`, and `gate()` (evaluate + verify in one call).
- **Sync and async clients** — `AtlaSentClient` (httpx.Client) and
  `AsyncAtlaSentClient` (httpx.AsyncClient) with full feature parity.
- **Pydantic v2 models** — `EvaluateResult`, `VerifyResult`, `GateResult`,
  plus request models with field aliases mapping SDK names to API wire format.

### Reliability

- Configurable retry with exponential backoff on 5xx, timeouts, and
  connection errors (`max_retries`, `retry_backoff`).
- `RateLimitError` on HTTP 429 with `retry_after` parsed from the
  `Retry-After` header.
- 10-second default timeout, configurable per-client.

### Configuration

- `AtlaSentClient(api_key, anon_key, base_url, timeout, max_retries, retry_backoff)`
- Global `configure()` + top-level `evaluate()`, `verify()`, `gate()` convenience
  functions with cached singleton client.
- Automatic fallback to `ATLASENT_API_KEY` and `ATLASENT_ANON_KEY` environment
  variables.

### Developer experience

- Structured logging via `logging.getLogger("atlasent")`.
- Context manager support (`with client:` / `async with client:`).
- Connection pooling — the top-level convenience functions reuse a singleton
  client across calls.
- PEP 561 `py.typed` marker for type checker support.
- GitHub Actions CI: ruff lint + black format + pytest across Python 3.10–3.12.

### Exceptions

- `AtlaSentError` — base exception for all SDK errors.
- `AtlaSentDenied(AtlaSentError)` — action explicitly denied, with `decision`,
  `permit_token`, and `reason` attributes.
- `ConfigurationError(AtlaSentError)` — missing API key or misconfiguration.
- `RateLimitError(AtlaSentError)` — HTTP 429 with optional `retry_after`.

### Packaging

- Dependencies: `httpx>=0.24.0`, `pydantic>=2.0.0`.
- Python 3.10+ required.
- MIT license.

### Tests

- 59 tests covering: permit/deny paths, retry logic, 429 handling,
  context managers, Pydantic model validation, convenience functions,
  async client parity, and exception hierarchy.
