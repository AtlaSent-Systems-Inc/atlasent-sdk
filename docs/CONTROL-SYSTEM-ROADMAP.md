# AtlaSent Control System Roadmap — atlasent-sdk (Python)

> **Role:** Python client SDK. Already fail-closed at the wrapper boundary (per audit: `python/atlasent/client.py:140-143, 212-271`). M3 tightens the contract so a permit is trusted ONLY after local signature verification and single-use consumption.
>
> **Master plan:** `atlasent-systems-inc/atlasent:docs/CONTROL-SYSTEM-ROADMAP.md`
>
> **Branch:** `claude/audit-atlasent-system-lhVC5`

## Ground truth (from audit)
- `python/atlasent/client.py:140-143` raises `AtlaSentDenied` — good.
- `python/atlasent/client.py:212-271` raises on network/5xx — good.
- `python/atlasent/guard.py` `atlasent_guard()` decorator is opt-in — acceptable.
- **Gap:** permit returned by `/v1/evaluate` is trusted end-to-end without local signature verification and without `consume`.

---

## M1 — Preparation

- [ ] Pin a minimum `atlasent-api` contract version
- [ ] Add `jwks_url` and `audience`/`org_id` config to `Client` constructor (defaults to production)
- [ ] Add `cryptography` library dependency (for Ed25519)

---

## M2 — No functional work

SDK does not change in M2. When `/v1/audit/events` POST ships, we'll add opt-in audit beacons post-execution.

---

## M3 — SDK Tightening (PRIMARY)

### New lifecycle

```
evaluate() → permit
  ↓
verify Ed25519 signature locally (JWKS cache)
  ↓
consume(permit.id) → 200 or fail-closed
  ↓
[caller executes protected function]
  ↓
audit.write(outcome)
```

### Implementation

- [ ] `python/atlasent/jwks.py` — fetch + cache JWKS by `kid`; TTL 1h with background refresh; retry with exponential backoff
- [ ] `python/atlasent/client.py`:
  - Add `_verify_permit_signature(permit)` using `cryptography.hazmat.primitives.asymmetric.ed25519.Ed25519PublicKey.verify`
  - Add `consume(permit_id: str) -> None` calling `POST /v1/permits/:id/consume`
  - Modify `evaluate()` to verify signature before returning
  - Modify `gate()` to: evaluate → verify → consume → return context manager / result
- [ ] `python/atlasent/guard.py`:
  - `atlasent_guard()` decorator calls `gate()` (which now includes verify + consume) before invoking wrapped function
  - On ANY step failure, raise `AtlaSentError` / `AtlaSentDenied` and do NOT call wrapped function
- [ ] Fail-closed on:
  - JWKS fetch failure (retries exhausted)
  - Signature verification failure
  - Missing/unknown `kid`
  - Consume 409/5xx/timeout

### Backward compatibility

- [ ] Major version bump (breaks wire-level contract with old control planes)
- [ ] If `jwks_url` returns 404 (old API), log a single warning and fall back to legacy HMAC trust — ONLY if `enable_legacy_permits=True` (default False). Document this flag prominently as a migration aid.

### Tests

- [ ] `tests/test_lifecycle.py`: evaluate → verify → consume → execute
- [ ] Replay rejected: second consume returns 409 → SDK raises
- [ ] Bad signature → SDK raises before consume
- [ ] JWKS 5xx → SDK raises (fail-closed)
- [ ] Network timeout on consume → SDK raises, wrapped function never runs

---

## M4 — Gateway Helper

- [ ] Add `client.permit_header(permit)` returning `{'X-AtlaSent-Permit': <token>}` — for callers using gateway-protected APIs directly without the guard decorator
- [ ] Document the SDK-less path (customers can use any HTTP client with this header)

---

## Cross-repo Dependencies

- **Depends on:** `atlasent-api` M1 (JWKS + consume endpoint)
- **Blocks:** `langchain-llamaindex-integration` M3 (SDK bump), `atlasent-examples` M3 (lifecycle examples)

---

## Verification (repo-local)

- Run against a local `atlasent-api` with M1 merged
- All lifecycle tests pass
- Replay test: issue permit, consume, retry consume → expect `AtlaSentDenied` / `AtlaSentError`
- Modify test client to skip local verification → control plane still rejects at consume (proves server-side check)

## PR Convention

`[M3] atlasent-sdk: Ed25519 verify + consume in SDK lifecycle`
