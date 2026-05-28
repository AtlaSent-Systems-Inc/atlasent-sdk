# B3.3 — Staging Rotation Drill: End-to-End Runbook

This runbook covers the end-to-end procedure for conducting a **staging
environment** trust-root signing-key rotation drill.  The drill validates that
the full key-rotation pipeline (key generation → snapshot publish → SDK refresh
→ bundle re-verification) works correctly before running the same procedure in
production.

**Scope**: R2 (Permit) and R3 (Audit export) key rotation.  R1 (Release /
cosign keyless) rotation uses Sigstore and follows a separate procedure.

---

## Prerequisites

| Item | Requirement |
|---|---|
| Environment | `staging` AtlaSent deployment |
| Access | `atlasent-keys` admin role |
| SDK version | Branch under test or latest release with B2.3–B2.5 merged |
| Tools | `openssl` or equivalent for Ed25519 key generation; `jq`; `atlasent-cli` |
| Test bundle | At least one valid audit export bundle from the staging tenant |

---

## Phase 0 — Baseline

1. **Record current `kid`** of the active R3_audit signing key:
   ```bash
   curl -s https://keys.atlasent.io/.well-known/atlasent-verifier-keys.json \
     | jq '[.keys[] | select(.role=="R3_audit")]'
   ```

2. **Verify a known-good bundle** with the current snapshot:
   ```bash
   atlasent-cli verify-bundle export.json
   # Expected: verified: true, matchedKeyId: <current_kid>
   ```

3. **Note the snapshot expiry**:
   ```bash
   curl -s https://keys.atlasent.io/.well-known/atlasent-trust-root.json | jq .valid_until
   ```

---

## Phase 1 — Generate new key

```bash
# Generate new Ed25519 key pair
openssl genpkey -algorithm ed25519 -out new-r3-audit.pem
openssl pkey -in new-r3-audit.pem -pubout -out new-r3-audit.pub.pem

# Extract the raw public key bytes (base64url) for the JWK
NEW_X=$(openssl pkey -in new-r3-audit.pem -pubout -outform DER \
  | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=')
NEW_KID="r3-audit-$(date +%Y%m%d)-01"  # e.g. r3-audit-20260601-01
```

---

## Phase 2 — Update snapshot files

### `atlasent-verifier-keys.json`

Add the new key entry to the `keys` array.  **Keep the old key** until the
grace period ends (see REVOCATION_RUNBOOK.md).

```json
{
  "kid": "<NEW_KID>",
  "role": "R3_audit",
  "kty": "OKP",
  "crv": "Ed25519",
  "alg": "EdDSA",
  "x": "<NEW_X>",
  "valid_from": "<ISO-8601 now>",
  "valid_until": null,
  "replaced_by": null,
  "revoked": false
}
```

### `atlasent-revocations.json`

Add the old kid to `revoked_keys`:

```json
{
  "kid": "<OLD_KID>",
  "role": "R3_audit",
  "revoked_at": "<ISO-8601 now>",
  "reason": "staging rotation drill — <date>"
}
```

### `atlasent-trust-root.json`

Extend `valid_until` by at least 8 days to give all SDK instances time to
refresh and for bundles signed with the new key to accumulate:

```bash
jq '.valid_until = "<NEW_VALID_UNTIL>"' atlasent-trust-root.json > tmp && mv tmp atlasent-trust-root.json
```

---

## Phase 3 — Publish and wait

```bash
# Push files to the staging well-known endpoint
atlasent-keys publish --env staging \
  atlasent-trust-root.json \
  atlasent-verifier-keys.json \
  atlasent-revocations.json

# Confirm the new snapshot is live
curl -s https://keys.atlasent.io/.well-known/atlasent-trust-root.json | jq .valid_until
```

Wait for background refresh.  Default interval is **4 hours**; for the drill
you can force an immediate refresh in test processes via:

```typescript
// TypeScript
const mgr = getGlobalTrustRootManager();
await (mgr as any)._doRefresh();
```

```python
# Python
from atlasent.trust_root import get_global_trust_root_manager
get_global_trust_root_manager()._do_refresh()
```

---

## Phase 4 — Verify

### 4a. New bundle signed with new key should verify

```bash
# Export a new bundle from the staging backend (it will use the new key)
atlasent-cli export-audit --env staging --out new-bundle.json
atlasent-cli verify-bundle new-bundle.json
# Expected: verified: true, matchedKeyId: <NEW_KID>
```

### 4b. Old bundle (signed with revoked key) should throw

```typescript
try {
  await verifyBundle("old-bundle.json");
} catch (err) {
  if (err instanceof BundleVerificationError && err.reason === "key_revoked") {
    console.log("PASS: revocation enforced as expected");
  }
}
```

```python
from atlasent.exceptions import BundleVerificationError
try:
    verify_bundle("old-bundle.json")
except BundleVerificationError as e:
    assert e.reason == "key_revoked", f"unexpected reason: {e.reason}"
    print("PASS: revocation enforced as expected")
```

### 4c. `AtlaSentDeniedError.isSigningKeyRevoked` on permit verification

If any permits were issued before the rotation, re-verify them; expect:

```typescript
catch (err) {
  if (err instanceof AtlaSentDeniedError && err.isSigningKeyRevoked) {
    console.log("PASS: permit_signing_key_revoked surfaced correctly");
  }
}
```

---

## Phase 5 — Rollback (if drill fails)

1. Remove the new key from `atlasent-verifier-keys.json`.
2. Remove the old kid from `atlasent-revocations.json`.
3. Restore the original `valid_until` in `atlasent-trust-root.json`.
4. Re-publish all three files.
5. Force a refresh in affected SDK instances.
6. Re-run Phase 0 baseline check to confirm recovery.

---

## Success criteria

| Check | Expected result |
|---|---|
| New bundle verifies | `verified: true`, `matchedKeyId: <NEW_KID>` |
| Old bundle raises | `BundleVerificationError(reason="key_revoked")` |
| Pre-rotation permit fails | `AtlaSentDeniedError(outcome="permit_signing_key_revoked")` |
| Half-life warning fires | One `console.warn` / `logging.warning` per process |
| Expiry warning fires | One `console.warn` / `logging.warning` per process if drill extends past `valid_until` |
| Rollback restores baseline | Phase 0 check passes after rollback |

---

## Related documents

- `REVOCATION_RUNBOOK.md` — SDK error matrix and branching guide
- `ADR-005` — Trust-root V1 design decisions (D2 refresh, D3 fail-closed)
- `vendor/trust-root/` — pinned vendor snapshot loaded at SDK startup
