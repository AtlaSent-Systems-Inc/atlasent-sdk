# SIM-09 — Concurrent consume

**Status:** fixture complete, tests pending implementation  
**Fixture:** `SIM-09.json`

## Scenario

Two `Enforce` instances with identical bindings race to consume a
single-use permit. `verifyPermit` succeeds exactly once. Exactly one
`run()` returns `allow` (and its `execute` runs); the other returns
`deny` with `permit_consumed`. `execute` runs exactly once in total.

## Setup

- Two `Enforce` instances with the same bindings and the same mock client.
- Both call `run()` concurrently (started in the same event-loop tick
  / coroutine group).
- `evaluate` mock always returns the same permit token
  `pt_single_use_concurrent_aabbcc`.
- `verify_permit` mock is a **concurrent_sequence**: first call resolves
  with the verified permit; all subsequent calls return HTTP 409
  `permit_consumed`. Harness must enforce first-wins ordering
  deterministically (e.g. via a shared counter).

## Action

```
[result1, result2] = await Promise.all([
  enforceA.run({ request, execute: spyA }),
  enforceB.run({ request, execute: spyB }),
])
```

## Expected

| Metric | Value |
|---|---|
| Total `allow` results | **1** |
| Total `deny` results | **1** |
| Deny `reason_code` | `permit_consumed` |
| `execute` total call count | **1** |

The specific winner is non-deterministic; the constraint is that exactly
one wins and one loses.

## Note on harness implementation

The `concurrent_sequence` mock type uses a shared atomic counter.
The first `verifyPermit` call increments the counter from 0 to 1 and
returns the success response; any call that sees counter ≥ 1 returns
`permit_consumed`. Both language harnesses must implement this using
their native concurrency primitives (Promise.all / asyncio.gather).

## Why this matters

Permits are single-use tokens. Concurrent access to the same permit must
not allow double-execution. The server is the source of truth for
consume-once semantics; the SDK must propagate the `permit_consumed`
denial faithfully without retry.
