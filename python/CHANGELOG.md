# Changelog

## Unreleased

## 1.5.0 — 2026-04-25

### Added

- **`list_audit_events()` and `create_audit_export()`.** Both
  `AtlaSentClient` and `AsyncAtlaSentClient` gain two new methods
  that close the long-standing `/v1-audit` parity gap. Together with
  the offline verifier (this release) and the pydantic models added
  here, customers can go from "I have an API key" to "I have a
  signed, offline-verifiable bundle of my org's audit events"
  without leaving the SDK:

        page = client.list_audit_events(
            types="evaluate.allow,policy.updated",
            limit=100,
        )
        # → AuditEventsResult(events=[AuditEvent(...)], total=..., next_cursor=..., rate_limit=...)

        result = client.create_audit_export(
            from_="2026-04-01T00:00:00Z",
            to="2026-04-30T23:59:59Z",
        )
        outcome = atlasent.verify_audit_bundle(result.bundle, keys=[...])

  `AuditEventsResult` is a pydantic model; `AuditExportResult` is a
  dataclass that wraps the raw server JSON so signature verification
  round-trips byte-for-byte (re-serializing through a pydantic model
  could reorder nested event fields and break the Ed25519 signature).
  Convenience accessors — `result.export_id`, `result.events`,
  `result.signature`, etc. — read from the preserved dict. A snake_case
  `from_` keyword sidesteps the Python reserved word without drifting
  from the wire.

  New public exports from `atlasent`:
  `AuditEvent`, `AuditEventsResult`, `AuditExportResult`,
  `AuditDecision`, `AuditExportSignatureStatus`.

- **Offline audit-bundle verifier.** `atlasent.verify_bundle(path,
  public_keys_pem=[...])` and the lower-level
  `atlasent.audit_bundle.verify_audit_bundle(bundle, keys)` produce a
  byte-faithful port of the reference verifier in
  `atlasent-api/supabase/functions/v1-audit/verify.ts`. End-to-end
  verification of a signed export from `POST /v1/audit/exports`:
  per-event SHA-256 hash chain, adjacency, `chain_head_hash` match,
  and detached Ed25519 signature. Rotation-aware via `signing_key_id`.
  Uses `cryptography` (now a hard dep). `canonical_json` and
  `signed_bytes_for` are exported for regulator-side tooling that
  wants to recompute envelope bytes out-of-band.
- Shared test fixtures at `contract/vectors/audit-bundles/` and
  reproducible generator at `contract/tools/gen_audit_bundles.py`.


## 1.4.0 — 2026-04-23

### Added

- **`key_self()` — API-key self-introspection.** Both `AtlaSentClient`
  and `AsyncAtlaSentClient` gain a `key_self()` method that calls
  `GET /v1-api-key-self` and returns the server's description of the
  key this client was constructed with:

        info = client.key_self()
        # ApiKeySelfResult(key_id=..., organization_id=...,
        #                  environment='live', scopes=['evaluate', ...],
        #                  allowed_cidrs=['10.0.0.0/8'],
        #                  rate_limit_per_minute=1000,
        #                  client_ip='10.2.3.4',
        #                  expires_at='2026-12-31T23:59:59Z',
        #                  rate_limit=RateLimitState(...))

  Never includes the raw key or its hash — introspection is
  intentionally read-only and safe to surface in operator dashboards.
  Useful for:

    - `IP_NOT_ALLOWED` debugging — `client_ip` is the IP the server
      observed (first hop of X-Forwarded-For).
    - Proactive expiry warnings — `expires_at` is the server-stored
      expiry (`None` means the key does not auto-expire).
    - Verifying scopes before attempting a scope-gated action.
    - "Which key am I?" in multi-tenant dashboards juggling more than
      one key.

  Response also includes `rate_limit` (the same `RateLimitState`
  surfaced on `evaluate`/`verify`), so key-introspection doubles as a
  cheap rate-limit probe without consuming a permit.

- `ApiKeySelfResult` exported from the package entry point (`from
  atlasent import ApiKeySelfResult`).

### Changed

- Internal refactor: the `_post` retry / error-mapping loop now
  delegates to a shared `_request(method, path, payload)` helper, and
  a parallel `_get` method exists for GET calls. Both `AtlaSentClient`
  and `AsyncAtlaSentClient` pick up the GET path so the rate-limit
  header parsing from 1.3.0 Just Works for key_self as well. No public
  API change.

### Non-breaking

Purely additive. Existing `evaluate` / `verify` / `gate` / `authorize`
/ `protect` APIs are unchanged — same signatures, same return types,
same exception taxonomy.

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
