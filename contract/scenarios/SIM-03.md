# SIM-03 — Permit-binding mismatch (actor)

**Status:** fixture complete, tests pending implementation  
**Fixture:** `SIM-03.json`

## Scenario

`evaluate` returns `allow` with a permit issued for `actor_id: actor_A`.
The `Enforce` instance is configured with `bindings.actor_id: actor_B`.
The SDK must deny pre-execute. `verifyPermit` independently asserts the
mismatch (belt-and-suspenders).

## Setup

- Enforce bindings: `{ org_id: org_test, actor_id: actor_B, action_type: deploy }`.
- `evaluate` returns `allow` + permit with `actor_id` baked into the token
  for `actor_A`.
- `verify_permit` mock returns HTTP 403 with `reason_code: binding_mismatch`.

## Action

```
enforce.run({ request, execute: spy })
```

## Expected

| Field | Value |
|---|---|
| `decision` | `deny` |
| `reason_code` | `binding_mismatch` |
| `execute` called | **no** |
| `verify_permit` called | **yes** |

## Why this matters

A permit is only valid for the exact `(org, actor, action)` tuple it was
issued for. Using a permit issued for a different actor must be denied even
if the server evaluates `allow` (the evaluate call may have been for a
different actor context). This is a double-check: both the SDK and the server
independently verify the binding tuple.
