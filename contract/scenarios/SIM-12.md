# SIM-12 — Permit not found

**Status:** fixture complete, tests pending implementation
**Fixture:** `SIM-12.json`

## Scenario

A permit token issued by `evaluate` doesn't resolve at `verifyPermit`
time. The 404-not-found path triggers when:

- The token was typo-mangled in transit (rare; covered by signature
  check in TLS).
- The token was issued in one tenant's namespace and is being
  verified in another's (cross-tenant misconfiguration).
- The pre-issuance race: a caller stashed the token before the
  server's transactional permit-write committed, and verify reaches
  the read replica before replication catches up.

`Enforce.run()` must deny with `reason_code: permit_not_found`.
`execute` must not run. Round-trips the server's `404 +
reason_code: permit_not_found` byte-identical into the
`EnforceRunResult`.

This completes the per-outcome SIM coverage matrix for the four
`PermitOutcome` discriminator values:

| Outcome | SIM | Title |
|---|---|---|
| `permit_consumed` | SIM-04 | Replay attempt |
| `permit_expired` | SIM-02 | Expired permit deny |
| `permit_revoked` | SIM-11 | Permit revoked mid-flight |
| `permit_not_found` | **SIM-12** | this scenario |

## Setup

- Single `Enforce` instance, single `run()` call.
- `evaluate` returns `allow` with permit token `pt_not_found_xx`.
- `verify_permit` is a single response: HTTP 404 with `reason_code:
  permit_not_found`.

## Action

```
result = await enforce.run({ request, execute: spy })
```

## Expected

| Metric | Value |
|---|---|
| `decision` | `deny` |
| `reason_code` | `permit_not_found` |
| `execute_called` | `false` |
| `verify_permit_called` | `true` |

## Why this matters

Without typed `permit_not_found` reasonCode, this case used to fall
into the generic `verify_client_error` bucket — operators couldn't
distinguish a real client mistake (typo, broken integration) from an
infrastructure race condition (pre-issuance replication lag). With
the typed discriminator added in atlasent-sdk PR #134, this scenario
locks the contract for the most ambiguous of the four outcomes.
