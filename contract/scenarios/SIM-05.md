# SIM-05 — verifyPermit 5xx — fail-closed deny

**Status:** fixture complete, tests pending implementation  
**Fixture:** `SIM-05.json`

## Scenario

`evaluate` returns `allow` with a valid permit. `verifyPermit` returns
HTTP 503. Enforce must deny with `verify_unavailable`. Critically, the
`allow` from `evaluate` must **not** leak into the result.

## Setup

- `evaluate` returns `allow` + valid permit (not expired, correct bindings).
- `verify_permit` mock returns HTTP 503 (no `reason_code`).

## Action

```
enforce.run({ request, execute: spy })
```

## Expected

| Field | Value |
|---|---|
| `decision` | `deny` |
| `reason_code` | `verify_unavailable` |
| `execute` called | **no** |
| `verify_permit` called | **yes** |

## Why this matters

This is the core fail-closed property. A degraded verification service
must never allow execution to proceed. An `allow` from `evaluate` alone
is insufficient — the verify step is non-optional. Any 5xx from
`verifyPermit` maps to `deny`, never to a fallback `allow`.
