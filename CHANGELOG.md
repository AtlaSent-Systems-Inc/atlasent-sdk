# Changelog

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
