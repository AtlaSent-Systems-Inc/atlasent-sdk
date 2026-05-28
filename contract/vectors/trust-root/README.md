# Trust-Root Contract Vectors

Test fixtures for the trust-root verification paths introduced in B2.3–B2.5 (ADR-005 D3).

## File format

Each `.jsonl` file is a **single JSON line** containing:

```jsonc
{
  "description": "human-readable test intent",
  "bundle": { /* AuditBundle object */ },

  // Optional: supply an already-expired snapshot for the expiry test.
  // Omitting this field means tests use the vendor snapshot.
  "stale_snapshot": { "valid_until": "2024-01-01T00:00:00Z", "issued_at": "..." },

  // Optional: supply a full fresh snapshot for the positive happy-path test.
  "fresh_snapshot": { "valid_until": "2099-...", "keys": [...], ... },

  // Optional: verifyAuditBundle / verify_audit_bundle call options
  "options": { "allow_expired_snapshot": true },

  // What the SDK must produce
  "expected": { /* see below */ }
}
```

## `expected` field semantics

### Throw paths (B2.4 fail-closed, ADR-005 D3)

When `verifyAuditBundle` / `verify_audit_bundle` must **throw**:

```jsonc
{
  "throws": "BundleVerificationError",   // error class name
  "reason": "trust_snapshot_expired",    // err.reason
  "snapshotValidUntil": "...",            // err.snapshotValidUntil (optional)
  "kid": "revoked-kid"                   // err.kid (optional, for revocation vectors)
}
```

### Return paths (no throw)

When the function must **return** a `BundleVerificationResult`:

```jsonc
{
  "verified": true,          // result.verified
  "chainIntegrityOk": true,  // result.chainIntegrityOk (optional)
  "signatureValid": true,    // result.signatureValid (optional)
  "matchedKeyId": "test-key" // result.matchedKeyId (optional)
}
```

## Vectors

| File | Scenario | Expected |
|---|---|---|
| `bundle_valid_fresh_snapshot.jsonl` | Happy path — valid sig, R3\_audit key, fresh snapshot | returns `{verified:true}` |
| `bundle_allow_expired.jsonl` | Expired snapshot with `allow_expired_snapshot=true` | returns `{verified:true}` |
| `bundle_expired_snapshot.jsonl` | Expired snapshot, no opt-out | throws `trust_snapshot_expired` |
| `bundle_revoked_kid.jsonl` | KID in revocation list | throws `key_revoked` |
| `bundle_role_mismatch.jsonl` | KID present but role is R2\_permit | throws `key_role_mismatch` |

## Trust-root snapshot used by each vector

- Vectors with `stale_snapshot` field: use that object as the `trustRoot`; it has a past `valid_until`.
- Vectors with `fresh_snapshot` field: use that object as the `trustRoot`; it has a far-future `valid_until` and the correct keys.
- Vectors with neither: pass the signing-key set from `contract/vectors/audit-bundles/signing-key.pub.pem` directly (no trust-root expiry check involved).

## Test key

The bundles in this directory are signed by the **test-only** key whose public key is
stored in `contract/vectors/audit-bundles/signing-key.pub.pem` and also embedded in
`vendor/trust-root/atlasent-verifier-keys.json` as `kid=test-key` / role `R3_audit`.
**Never use this key in production.**
