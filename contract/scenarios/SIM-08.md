# SIM-08 — Cross-org permit

**Status:** fixture complete, tests pending implementation  
**Fixture:** `SIM-08.json`

## Scenario

`evaluate` returns `allow` with a permit issued for `org_id: org_A`.
The `Enforce` instance is configured with `bindings.org_id: org_B`.
Both the SDK-level binding check and the server-side `verifyPermit` must
deny with `binding_mismatch`. `execute` must not run.

## Setup

- Enforce bindings: `{ org_id: org_B, actor_id: actor_test, action_type: deploy }`.
- `evaluate` returns `allow` + permit bearing `org_id: org_A` in the token.
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

Permits must not cross organizational boundaries. A permit issued for
`org_A` must never authorize action in the context of `org_B`, even if
a misconfigured evaluate call returned `allow` for the wrong org. This
is the org-isolation invariant.
