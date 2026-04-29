# SIM-01 — No-permit deny

**Status:** fixture complete, tests pending implementation  
**Fixture:** `SIM-01.json`

## Scenario

The authorization server evaluates the request and returns a `deny` decision.
No permit token is issued. The Enforce wrapper must pass the denial through and
must never invoke the `execute` callback.

## Setup

- `evaluate` mock returns `{ decision: "deny", permit: null, reason_code: "policy_deny" }`.
- `verify_permit` is never called (no permit to verify).
- `execute` callback is a spy that asserts it was never called.

## Action

```
enforce.run({ request: { commit, environment }, execute: spy })
```

## Expected

| Field | Value |
|---|---|
| `decision` | `deny` |
| `reason_code` | `policy_deny` (passed through from server) |
| `execute` called | **no** |
| `verify_permit` called | **no** |

## Why this matters

Guards against a regression where the wrapper treats a missing `decision`
field as an implicit allow, or where a non-`allow` decision triggers
execution anyway.
