# SIM-01..SIM-10 — Enforce Pack scenario suite (DRAFT)

Status: **draft, not yet implemented.** Defines the simulation gate
the SDK Strategy Lock (2026-04-29) requires before any Preview-pack
code merges.

## Purpose

Every scenario is a deterministic test against a recorded fixture
(canned API responses, fake clock) that exercises one specific
fail-closed property of the Enforce Pack. They run on every PR to
`@atlasent/enforce` and `atlasent-enforce` and on every release tag.

The scenarios live in:

```
contract/scenarios/SIM-01.json   shared input + expected outcome
contract/scenarios/SIM-01.md     human-readable narrative
typescript/packages/enforce/test/sim/SIM-01.test.ts
python/atlasent_enforce/tests/sim/test_sim_01.py
```

Both language tests consume the shared `.json` fixture so behavior
drift between TS and Python is impossible.

## Scenario list

### SIM-01 — No-permit deny
**Setup.** Server responds to `evaluate` with a `deny` decision (no permit issued).
**Action.** Caller invokes `Enforce.run({ ..., execute })`.
**Expected.** `execute` callback is never invoked. Result is `decision: deny`. Reason code passes through from server.

### SIM-02 — Expired permit deny
**Setup.** `evaluate` returns `allow` with a permit whose `expires_at` is in the past (clock fixture).
**Action.** `Enforce.run`.
**Expected.** `verifyPermit` is called and rejects on TTL. `execute` not invoked. `decision: deny`, `reason_code: permit_expired`.

### SIM-03 — Permit-binding mismatch
**Setup.** `evaluate` returns `allow` with a permit issued for `actor_id: A`. Enforce instance is configured with `bindings.actorId: B`.
**Action.** `Enforce.run`.
**Expected.** Wrapper rejects pre-execute. `execute` not invoked. `decision: deny`, `reason_code: binding_mismatch`. (Belt-and-suspenders: server's `verifyPermit` should also reject; SIM-03 verifies the SDK does too without trusting the server.)

### SIM-04 — Replay attempt
**Setup.** Permit issued, consumed once successfully (recorded fixture). A second `Enforce.run` is invoked with the same permit token (caller smuggles it via instance state).
**Action.** Second `Enforce.run`.
**Expected.** `verifyPermit` returns `permit_consumed`. `execute` not invoked. `decision: deny`, `reason_code: permit_consumed`.
Note: the public surface doesn't accept a permit-token parameter (Enforce always issues a fresh one), so this scenario tests the wrapper's resistance to constructor-injected permits and to direct mutation of internal state.

### SIM-05 — verifyPermit 5xx → fail-closed deny
**Setup.** `evaluate` returns `allow` + permit. `verifyPermit` returns HTTP 503.
**Action.** `Enforce.run`.
**Expected.** No retry. `execute` not invoked. `decision: deny`, `reason_code: verify_unavailable`. Critical: the `allow` from `evaluate` does NOT leak into the result — server-side allow alone is insufficient.

### SIM-06 — Latency-budget breach during verify
**Setup.** `evaluate` returns `allow`. `verifyPermit` is artificially slowed past the configured `latency_budget_ms`.
**Action.** `Enforce.run` with `latencyBreachMode: "deny"`.
**Expected.** Wrapper aborts the in-flight verify, denies. `decision: deny`, `reason_code: verify_latency_breach`. Companion case: `latencyBreachMode: "warn"` — wrapper still waits for verify completion and surfaces a warning event but does not deny on time alone (only on the actual verify result).

### SIM-07 — Tampered permit token
**Setup.** `evaluate` returns `allow` + permit. Test fixture flips one byte of the permit signature before `verifyPermit` is called.
**Action.** `Enforce.run`.
**Expected.** `verifyPermit` returns signature-invalid. `execute` not invoked. `decision: deny`, `reason_code: permit_tampered`.

### SIM-08 — Cross-org permit
**Setup.** Permit issued for `org_id: ORG_A`. Enforce instance bound to `ORG_B`.
**Action.** `Enforce.run`.
**Expected.** Wrapper rejects pre-execute (binding check). `execute` not invoked. `decision: deny`, `reason_code: binding_mismatch`. Server-side check is also asserted as redundant defense.

### SIM-09 — Concurrent consume
**Setup.** Two `Enforce` instances, same bindings, race a single-use permit. Server is configured with the real consume-once semantics; `verifyPermit` is allowed to succeed exactly once.
**Action.** Two `Enforce.run` calls in parallel.
**Expected.** Exactly one returns `allow` (and its `execute` runs). The other returns `deny` with `reason_code: permit_consumed`. No `execute` runs twice. Both calls are deterministic in their failure mode.

### SIM-10 — Wrapper-bypass attempt (static)
**Setup.** A test-fixture file imports the v1 `AtlasentClient` directly and calls `evaluate()` without going through Enforce.
**Action.** Run the `enforce-no-bypass` lint rule (CI job).
**Expected.** Lint fails on the test fixture, with a pointer to the offending import. (The lint is what enforces invariant 7 of `ENFORCE_PACK.md` — SIM-10 is the test that the lint actually catches it.)

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

Any new fail-closed property added to Enforce after v1 of this spec
becomes SIM-11+. The numbering is append-only.

## Promotion gate

1. All ten scenarios pass in CI for both TypeScript and Python.
2. The `enforce-no-bypass` lint runs in CI and is required.
3. Coverage on the Enforce package is 100% lines, 100% branches.
4. Manual sign-off is recorded in `contract/SIM_SIGNOFF.md` (one line per release tag).

Until all four are satisfied, no Preview-pack PR merges. Documented
in `CLAUDE.md` as a hard project rule.

## Open questions

- Should SIM-09 (concurrent consume) be an integration test against a real ephemeral Supabase, or stay fixture-only? Fixture-only is faster; real-server is more honest. Lean toward fixture-only at SIM scope, with a separate `it-09-real-server.test.ts` flagged for the integration-gate evidence.
- Should SIM-10 (no-bypass lint) live in this contract dir or in `enforce-no-bypass.config.json` next to the package? Keeping the lint config next to its enforcement target reads better; the SIM-10 *test* stays in the suite and just shells the lint.
- Latency fixture clock: hand-roll a fake clock per language, or adopt a shared time-control library? Hand-roll — adds zero deps, keeps the suite hermetic.
