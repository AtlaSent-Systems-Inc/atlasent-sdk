# Changelog

## 0.1.0 — 2026-05-13

First public release. Locks the V1 execution-time authorization runtime surface.

> **Scope:** This release covers evaluate, permit verification, streaming evaluation, and offline bundle verification. It is a stabilization tag, not a completeness tag — additional endpoints and type-generation tooling are tracked for the next release cycle.

### Core runtime surface

- **`authorize(agent, action, context?)`** — Stripe-style one-call entrypoint. Calls `POST /v1-evaluate` and (by default) `POST /v1-verify-permit`. Returns `AuthorizationResult` with `permitted`, `reason`, `permit_token`, `audit_hash`, `permit_hash`, `verified`, and `timestamp`. Truthy when permitted.
- **`AtlaSentClient`** — synchronous client (`httpx.Client`): `evaluate()`, `verify()`, `gate()`, `authorize()`.
- **`AsyncAtlaSentClient`** — async client (`httpx.AsyncClient`): full parity with sync surface plus `evaluate_stream()`.
- **`evaluate_stream(action, agent, context?)`** — async generator yielding `EvaluateStreamEvent` objects over SSE from `POST /v1-evaluate-stream`. Events: `"reasoning"`, `"policy_check"`, `"decision"`. A `DENY` decision is yielded, not raised.
- **`verify_bundle(path)`** — offline Ed25519 audit bundle verifier. No network call. Returns `BundleVerifyResult` with `valid`, `event_count`, `public_key`, and `error`. Requires `pip install "atlasent[audit]"` (`cryptography>=41.0`).

### Reliability

- Configurable retry with exponential backoff on 5xx, timeouts, and connection errors.
- `RateLimitError` on HTTP 429 with `retry_after` parsed from the `Retry-After` header.
- Per-request `X-Request-ID` header for log correlation.
- 10-second default timeout, configurable per-client.

### Developer experience

- `@atlasent_guard` / `@async_atlasent_guard` decorators for Flask / FastAPI routes.
- `TTLCache` — opt-in in-process cache for hot-path evaluations.
- Structured logging via `logging.getLogger("atlasent")`.
- Global `configure()` + top-level `authorize()`, `evaluate()`, `verify()`, `gate()` convenience functions.
- `ATLASENT_API_KEY` / `ATLASENT_ANON_KEY` environment variable support.
- PEP 561 `py.typed` marker.

### Exceptions

- `AtlaSentError(code, status_code, response_body)` — base for all SDK errors.
- `AtlaSentDenied(AtlaSentError)` — action explicitly denied.
- `PermissionDeniedError(AtlaSentDenied)` — raised by `authorize(..., raise_on_deny=True)`.
- `ConfigurationError(AtlaSentError)` — missing API key or misconfiguration.
- `RateLimitError(AtlaSentError)` — HTTP 429 with optional `retry_after`.

### Models

- `AuthorizationResult`, `EvaluateResult`, `VerifyResult`, `GateResult` — response types.
- `EvaluateStreamEvent` — streaming event with `type`, `content`, `policy_id`, `outcome`, `permitted`, `permit_token`, `reason`, `audit_hash`, `timestamp`.
- `BundleVerifyResult` — audit bundle verification result.
- `AuditEvent` — individual event record inside a bundle.

### Packaging

- Dependencies: `httpx>=0.24.0`, `pydantic>=2.0.0`.
- Optional: `cryptography>=41.0` (`pip install "atlasent[audit]"`).
- Python 3.10+ required.
- MIT license.
- PyPI trusted publishing via OIDC (PEP 740 attestations).

### Tests

- 174 tests across unit, async, contract-vector, streaming, and audit suites.

### Not included in 0.1.0

Deferred to a future release:

- `POST /v1-session`, `GET/POST /v1-audit/events`, `GET /v1-audit/exports`, `POST /v1-audit/verify`
- `POST /v1-approvals`, `POST /v1-overrides`, `POST /v1-permits/consume`, `POST /v1-permits/revoke`
- Generated Pydantic models from the OpenAPI spec (models are hand-maintained)
