# Changelog

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
