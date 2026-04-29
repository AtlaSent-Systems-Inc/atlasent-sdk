# SIM-02 — Expired permit deny

**Status:** fixture complete, tests pending implementation  
**Fixture:** `SIM-02.json`

## Scenario

`evaluate` returns `allow` and issues a permit, but the permit's `expires_at`
is in the past relative to `clock.now_iso`. `verifyPermit` rejects the token
with `permit_expired`. `execute` must not run.

## Setup

- Clock fixed at `2026-04-29T12:00:00Z`.
- `evaluate` returns `allow` + permit with `expires_at: 2026-04-29T11:59:00Z`
  (one minute before clock).
- `verify_permit` mock returns HTTP 400 with `reason_code: permit_expired`.

## Action

```
enforce.run({ request, execute: spy })
```

## Expected

| Field | Value |
|---|---|
| `decision` | `deny` |
| `reason_code` | `permit_expired` |
| `execute` called | **no** |
| `verify_permit` called | **yes** |

## Why this matters

Validates that an `allow` decision from `evaluate` is insufficient on its own.
The permit must survive `verifyPermit` before execution is allowed. An expired
permit must never unlock execution even if the server's evaluate endpoint
returned `allow`.
