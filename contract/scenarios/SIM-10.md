# SIM-10 — Wrapper-bypass attempt (static lint)

**Status:** fixture complete, lint pending implementation  
**Fixture:** `SIM-10.json`  
**Bypass fixtures:** `SIM-10-bypass-fixture.ts`, `SIM-10-bypass-fixture.py`

## Scenario

A source file inside the `@atlasent/enforce` package imports the v1
`AtlasentClient` directly and calls `evaluate()` without going through
`Enforce.run()`. The `enforce-no-bypass` lint rule (CI job) must detect
this pattern and exit non-zero, pointing to the offending import.

## Setup

- `SIM-10-bypass-fixture.ts` / `SIM-10-bypass-fixture.py`: synthetic
  files that contain the disallowed direct-evaluate pattern.
- `enforce-no-bypass` lint is run against these fixtures.

## Action

```
# TypeScript
node scripts/enforce-no-bypass.mjs contract/scenarios/SIM-10-bypass-fixture.ts

# Python
python scripts/enforce_no_bypass.py contract/scenarios/SIM-10-bypass-fixture.py
```

## Expected

| Metric | Value |
|---|---|
| Lint exit code | **1** (non-zero) |
| Reported file | path to the bypass fixture |
| Error text includes | `"enforce-no-bypass"` and `"evaluate"` |

## Why this matters

Invariant 7 of `ENFORCE_PACK.md` states that no code in the Enforce
package may call `evaluate()` outside the wrapper. Without a lint check
enforcing this, a contributor could accidentally (or intentionally) add
a parallel execution path that bypasses `verifyPermit`. SIM-10 is the
test that the lint is actually wired up and catches real bypass patterns.
