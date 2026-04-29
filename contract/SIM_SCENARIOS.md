# SIM-01..SIM-10 — Enforce Pack scenario suite

Status: **fixtures complete; implementations passing in TS + Python.**  
Gate: all ten must pass in CI before any Preview-pack code merges.

## Purpose

Each scenario is a deterministic test against a recorded fixture
(canned API responses, fake clock) that exercises one specific
fail-closed property of the Enforce Pack. They run on every PR to
`@atlasent/enforce` / `atlasent-enforce` and on every release tag.

## File layout

```
contract/scenarios/SIM-XX.json   shared input + expected outcome (source of truth)
contract/scenarios/SIM-XX.md     human-readable narrative

typescript/packages/enforce/test/sim/SIM-XX.test.ts
python/atlasent_enforce/tests/sim/test_sim_XX.py
```

Both language test suites consume the shared `.json` fixture through
their respective harnesses (`test/sim/harness.ts`,
`tests/sim/harness.py`), so TS/Python behavioural drift is impossible.

## Scenario index

| ID | Title | Fail-closed property |
|---|---|---|
| [SIM-01](scenarios/SIM-01.md) | No-permit deny | Server deny blocks execute |
| [SIM-02](scenarios/SIM-02.md) | Expired permit deny | Permit TTL enforced |
| [SIM-03](scenarios/SIM-03.md) | Permit-binding mismatch (actor) | Actor identity validated |
| [SIM-04](scenarios/SIM-04.md) | Replay attempt | Permits are single-use |
| [SIM-05](scenarios/SIM-05.md) | verifyPermit 5xx — fail-closed deny | Evaluate allow does NOT leak |
| [SIM-06](scenarios/SIM-06.md) | Latency-budget breach | deny + warn modes |
| [SIM-07](scenarios/SIM-07.md) | Tampered permit token | Signature integrity |
| [SIM-08](scenarios/SIM-08.md) | Cross-org permit | Org isolation |
| [SIM-09](scenarios/SIM-09.md) | Concurrent consume | Single-use under concurrency |
| [SIM-10](scenarios/SIM-10.md) | Wrapper-bypass attempt (static) | enforce-no-bypass lint |

## Coverage matrix

| Concern | Covered by |
|---|---|
| Server denies → execute blocked | SIM-01 |
| Permit TTL | SIM-02 |
| Identity / org binding | SIM-03, SIM-08 |
| Replay / single-use | SIM-04, SIM-09 |
| Verify-side server failure | SIM-05 |
| Latency budget | SIM-06 |
| Cryptographic integrity | SIM-07 |
| Static-analysis non-bypass | SIM-10 |

## Promotion gate

1. All ten scenarios pass in CI for both TypeScript and Python.
2. The `enforce-no-bypass` lint runs in CI and is required (SIM-10).
3. Coverage on the Enforce package is 100% lines, 100% branches.
4. Manual sign-off is recorded in `contract/SIM_SIGNOFF.md` (one line per release tag).

Until all four are satisfied, no Preview-pack PR merges.

## Adding new scenarios

New fail-closed properties become SIM-11+. The numbering is
append-only. Each new scenario requires:
- `contract/scenarios/SIM-NN.json` — fixture
- `contract/scenarios/SIM-NN.md` — narrative
- `typescript/packages/enforce/test/sim/SIM-NN.test.ts`
- `python/atlasent_enforce/tests/sim/test_sim_NN.py`
- A row in the index and coverage-matrix tables above
