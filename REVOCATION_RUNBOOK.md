# AtlaSent SDK — Revocation Runbook

Operator-facing guide for signing-key rotation, permit revocation, and
the SDK error signals downstream callers will receive.

---

## SDK Error Matrix

All errors in this table are **thrown / raised** — they are never silently
returned as a falsy result.  Callers must catch them explicitly.

| Thrown class | `reason` / `outcome` field | Trigger |
|---|---|---|
| `BundleVerificationError` | `trust_snapshot_expired` | `verify_bundle` / `verify_audit_bundle` called while the active trust-root snapshot's `valid_until` has passed (ADR-005 D3). Pass `allowExpiredSnapshot: true` / `allow_expired_snapshot=True` to opt out (air-gap only). |
| `BundleVerificationError` | `key_revoked` | Bundle's `signing_key_id` appears in `revoked_keys` of the active snapshot. |
| `BundleVerificationError` | `key_role_mismatch` | Signing key's `role` in the snapshot is not `R3_audit`. |
| `AtlaSentDeniedError` | `permit_signing_key_revoked` | Permit's signing KID appears in the trust-root revocation list during permit verification (ADR-005 D3 R2/R3 key rotation). Surface: `error.isSigningKeyRevoked === true` (TS) / `error.is_signing_key_revoked` (Python). |
| `AtlaSentDeniedError` | `permit_revoked` | Permit explicitly revoked via the D3 revocation endpoint. Surface: `error.isRevoked`. |
| `AtlaSentDeniedError` | `permit_expired` | Permit TTL passed before verification. Surface: `error.isExpired`. |
| `AtlaSentDeniedError` | `permit_consumed` | Single-use permit already consumed by an earlier verify call. Surface: `error.isConsumed`. |
| `AtlaSentDeniedError` | `permit_not_found` | Permit ID not recognised server-side (typo, cross-tenant, pre-issuance race). Surface: `error.isNotFound`. |

### TypeScript error branching

```typescript
try {
  await verifyBundle("export.json");
} catch (err) {
  if (err instanceof BundleVerificationError) {
    switch (err.reason) {
      case "trust_snapshot_expired":
        // snapshot refresh pending — retry or alert ops
        break;
      case "key_revoked":
        // signing key rotated out — incident, request new export
        break;
      case "key_role_mismatch":
        // misconfigured key — platform bug, escalate
        break;
    }
  }
}
```

### Python error branching

```python
from atlasent.exceptions import BundleVerificationError

try:
    verify_bundle("export.json")
except BundleVerificationError as err:
    if err.reason == "trust_snapshot_expired":
        pass  # snapshot refresh pending — retry or alert ops
    elif err.reason == "key_revoked":
        pass  # signing key rotated out — incident
    elif err.reason == "key_role_mismatch":
        pass  # platform misconfiguration — escalate
```

---

## Half-life warning

When the active snapshot passes its midpoint (`(valid_until - issued_at) / 2`)
the SDK emits a **one-time per process** warning:

- **TypeScript**: `console.warn("[AtlaSent] trust-root snapshot is past its half-life...")`
- **Python**: `logging.warning("[AtlaSent] trust-root snapshot is past its half-life...")`  
  (logger name: `atlasent.trust_root`)

The warning fires at most once; subsequent `checkExpiry()` calls are silent.
An expired-snapshot warning fires separately, also at most once.

---

## Signing-key rotation procedure

### R2 (Permit) or R3 (Audit export) key rotation

1. **Generate new key pair** on the HSM / key-management system.
2. **Publish new key** to `atlasent-verifier-keys.json` with the new `kid`.
3. **Add old kid** to `atlasent-revocations.json` under `revoked_keys` with
   an appropriate `revoked_at` ISO-8601 timestamp and `reason`.
4. **Bump `valid_until`** in `atlasent-trust-root.json` to extend the snapshot
   window (ensures in-flight bundles signed with the old key remain verifiable
   until the rotation grace period ends).
5. **Push snapshot** files to `https://keys.atlasent.io/.well-known/`.
6. **Wait 4 hours** (default refresh interval) for all SDK instances to pick
   up the new snapshot via background refresh.
7. **Verify**: attempt `verify_bundle` on a freshly exported bundle; expect
   `result.verified === true` with `matchedKeyId` pointing to the new kid.

### Grace period

Old-key bundles exported before the revocation timestamp remain verifiable
until the snapshot's `valid_until` passes (fail-closed cuts off all
verification at that point).  Plan rotation windows to ensure:

```
revocation_timestamp + expected_bundle_retention_period < snapshot_valid_until
```

---

## Permit revocation (D3 endpoint)

```
POST /v1/permits/{permit_id}/revoke
Authorization: Bearer <api_key>
```

Caller receives `AtlaSentDeniedError` with `outcome === "permit_revoked"` on
the next verification attempt.  The SDK's `error.isRevoked` getter returns
`true` as a convenience predicate.

### `permit_signing_key_revoked` flow

This outcome is emitted when the server validates a permit and finds that the
permit's `signing_key_id` appears in the live trust-root revocation list.  It
indicates the key used to issue the permit has been retired.  Operators should:

1. Confirm the rotation was intentional (check `atlasent-revocations.json`).
2. Re-issue any in-flight permits that were signed with the retired key.
3. Investigate permits issued after the `revoked_at` timestamp; they represent
   a key-management incident.

---

## Air-gap / offline operation

Pass `allowExpiredSnapshot: true` / `allow_expired_snapshot=True` to
`verify_bundle` to skip the fail-closed expiry check.  This mode is intended
exclusively for isolated environments that cannot reach `keys.atlasent.io`.

```typescript
const result = await verifyBundle(exportPath, { allowExpiredSnapshot: true });
```

Revocation checks are still applied when `allowExpiredSnapshot: true` is set;
only the expiry guard is bypassed.
