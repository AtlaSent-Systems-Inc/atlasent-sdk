# SIM-06 — Latency-budget breach during verify

**Status:** fixture complete, tests pending implementation  
**Fixture:** `SIM-06.json`

## Scenario

`evaluate` returns `allow`. `verifyPermit` is artificially delayed past
`latency_budget_ms` (200 ms). Two cases are exercised:

- **deny mode** (`latency_breach_mode: "deny"`): wrapper aborts the
  in-flight verify, denies immediately with `verify_latency_breach`.
- **warn mode** (`latency_breach_mode: "warn"`): wrapper notes the
  breach and continues waiting for `verifyPermit` to complete; the
  final decision is based on the actual verify result.

## Setup

- `enforce_config.latency_budget_ms`: 200.
- `verify_permit` mock: delays 500 ms, then resolves with a valid
  verified permit.

## Action

```
// Case A — deny mode
enforceA.run({ request, execute: spy })

// Case B — warn mode
enforceB.run({ request, execute: spyB })
```

## Expected

| Case | `latency_breach_mode` | `decision` | `reason_code` | `execute` | `warn_emitted` |
|---|---|---|---|---|---|
| A | `deny` | `deny` | `verify_latency_breach` | **no** | — |
| B | `warn` | `allow` | — | **yes** | **yes** |

## Why this matters

Latency budget enforcement prevents a slow verification service from
holding up production traffic indefinitely in deny mode. In warn mode,
operators can observe breaches without failing closed, which is useful
during gradual rollout when verify latency is still being profiled.
