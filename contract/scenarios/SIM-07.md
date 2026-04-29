# SIM-07 — Tampered permit token

**Status:** fixture complete, tests pending implementation  
**Fixture:** `SIM-07.json`

## Scenario

`evaluate` returns `allow` with a permit. The test harness flips one byte
of the permit token before `verifyPermit` is called (`tamper_token: true`
in the verify mock). `verifyPermit` returns HTTP 400 with
`reason_code: permit_tampered`. `execute` must not run.

## Setup

- `evaluate` returns `allow` + permit with token `pt_valid_sig_aabbcc`.
- Test harness mutates the token (XOR first byte, or append `"X"`) before
  passing to `verifyPermit`.
- `verify_permit` mock returns HTTP 400 with `reason_code: permit_tampered`.

## Action

```
enforce.run({ request, execute: spy })
// Internally: evaluate() → token mutated by harness → verifyPermit(mutated_token)
```

## Expected

| Field | Value |
|---|---|
| `decision` | `deny` |
| `reason_code` | `permit_tampered` |
| `execute` called | **no** |
| `verify_permit` called | **yes** |

## Note on harness implementation

The `tamper_token: true` flag tells the test harness to intercept the
`verifyPermit` call and corrupt the token before forwarding it to the
mock. This simulates a MITM or memory-tampering attack on the token
between `evaluate` and `verifyPermit`.

## Why this matters

Permits are cryptographically signed. Any in-transit mutation must be
detected and denied. The SDK must not try to execute on a permit whose
signature has been invalidated.
