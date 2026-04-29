# SIM-04 — Replay attempt

**Status:** fixture complete, tests pending implementation  
**Fixture:** `SIM-04.json`

## Scenario

A permit is consumed by the first `Enforce.run()` call. A second
`Enforce.run()` call with the same permit token must be denied with
`permit_consumed`. `execute` runs exactly once.

## Setup

- Both calls use the same `Enforce` instance and identical requests.
- `evaluate` always returns `allow` with the same permit token
  `pt_single_use_aabbcc`.
- `verify_permit` is a **sequence** mock:
  - Call 1: returns verified permit (success).
  - Call 2: returns HTTP 409 with `reason_code: permit_consumed`.

## Action

```
// Phase 1
result1 = await enforce.run({ request, execute: spy })

// Phase 2 — replay
result2 = await enforce.run({ request, execute: spy })
```

## Expected

| Phase | `decision` | `reason_code` | `execute` called |
|---|---|---|---|
| 1 (first run) | `allow` | — | **yes** |
| 2 (replay) | `deny` | `permit_consumed` | **no** |

`execute` total call count: **1**.

## Why this matters

Permits are single-use. A consumed permit must not unlock a second
execution even if `evaluate` re-issues an `allow` (the mock reuses the
same token to simulate a replay scenario where the caller has captured the
token from internal state). The Enforce wrapper must not cache or reuse
`verifyPermit` results across calls.
