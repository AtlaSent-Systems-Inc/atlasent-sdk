# Approval Deny Reasons

This document is the canonical taxonomy of structured deny codes that the
AtlaSent SDK enforcement layer raises. Both the canonical TypeScript
implementation in `atlasent-sdk/typescript/src/governanceEnforcement.ts`
and the canonical Python implementation in
`atlasent-sdk/python/atlasent/governance/enforcement.py` produce the
*same* deny code string for the *same* advisory result, byte-for-byte.
The cross-language guarantee is enforced by the parity fixture at
`compat/governance/fixtures/parity.json` (the deny-code taxonomy section)
and the corresponding compat tests in both SDKs.

## How to read this document

Deny codes are namespaced by **gate**: the enforcement helper that
produced them.

- `financial_quorum` — raised by `enforce_financial_quorum` /
  `enforceFinancialQuorum` when a `FinancialQuorumResult` indicates the
  action does not satisfy quorum.
- `budget` — raised by `enforce_budget_constraint` /
  `enforceBudgetConstraint` when a `BudgetConstraintCheckResult` carries
  one or more hard blocks.
- `autonomous_bounds` — raised by `enforce_autonomous_bounds` /
  `enforceAutonomousBounds` when an `AutonomousExecutionCheckResult`
  reports an out-of-bounds autonomous execution.

The **fully-qualified code** (`<gate>/<deny_code>`, e.g.
`financial_quorum/blocked_by_emergency_freeze`) is the form that should
appear in audit records and operator dashboards. The error object
exposes it as `fully_qualified_code` (Python) /
`fullyQualifiedCode` (TypeScript).

When multiple checks within a gate would fail simultaneously, both SDKs
emit the deny code for the **first** failing check in the canonical
evaluation order documented below. This guarantees the same advisory
result produces the same deny code regardless of language.

## Adding a new deny code

1. Add the row to the appropriate table in this document.
2. Add the literal string to the gate's Literal type alias in both
   `governanceEnforcement.ts` and `enforcement.py`.
3. Update the dispatch logic in both files so the code is emitted on
   the matching advisory failure.
4. Add the code to `compat/governance/fixtures/parity.json`
   (`governance_deny_codes` section).
5. Add a test case in both `python/tests/governance/test_enforcement.py`
   and `typescript/test/governance/enforcement.test.ts`.

If any of those steps is skipped, the cross-language compat test fails
on the next CI run.

---

## financial_quorum gate

Evaluation order (canonical). The first failing check determines the deny
code emitted; later failing checks are recorded on the advisory result
but do not surface to the error.

1. `blocked_by_freeze`
2. `base_quorum_passed`
3. `amount_threshold_satisfied`
4. `financial_roles_satisfied`
5. `regulator_approval_missing`

| Deny code | Fires when | Operator action |
|---|---|---|
| `blocked_by_emergency_freeze` | One or more `active_freezes` records is `lifted=False` and matches the action's scope. | Resolve the freeze (lift it) before retrying, or wait for `expires_at`. The originating freeze record's `freeze_id` and `reason` are in `error.reason`. |
| `base_count_unmet` | `approval_count < policy.required_count` and no `base_quorum_proof` was supplied. | Collect more approvals; the advisory `unmet_requirements` lists how many are missing. |
| `amount_threshold_unmet` | `action_value` crosses one or more `amount_thresholds` and the threshold's `additional_approvals` / `additional_roles` / `senior_review_required` requirements are not met. | Either reduce `action_value` below the threshold or collect the additional approvals / role coverage the threshold demands. |
| `financial_role_unmet` | A `financial_role_requirements` entry filtered to the action's `risk_tier` / `applies_above` is not satisfied by `present_roles`. | Add an approval from the missing role (commonly `cfo` for `high` and `critical` tiers). |
| `regulator_approval_missing` | `regulator_approval_threshold` is set, `action_value >= threshold`, and `regulator_approval_present` is False. | Obtain regulator approval out-of-band and pass `regulator_approval_present=True` on retry. |

## budget gate

Deny codes map directly from `BudgetViolation.violation_type` on the
first entry of `result.hard_blocks`. Soft warnings
(`result.soft_warnings`) are NEVER raised — they are advisory only.

| Deny code | Fires when | Operator action |
|---|---|---|
| `limit_exceeded` | A `BudgetLimit` would be exceeded by the projected spend (`spent_amount + action_value > limit_amount`) and the limit's `enforcement` is `"hard"`. | Reduce the action value, raise the limit, or wait for the next budget period to roll over. |
| `single_transaction_exceeds` | `action_value > constraint.max_single_transaction`. | Split the transaction into smaller ones, or revise the constraint. |
| `daily_aggregate_exceeds` | `current_daily_spend + action_value > constraint.max_daily_aggregate`. | Wait for the daily window to roll over (UTC midnight by convention) or raise the constraint. |
| `monthly_aggregate_exceeds` | `current_monthly_spend + action_value > constraint.max_monthly_aggregate`. | Wait for the monthly window or raise the constraint. |
| `anonymous_agent_blocked` | `is_anonymous_agent=True` against a constraint whose `allow_anonymous_agents=False`. | Bind the action to a named agent identity; emergency override on the constraint requires a separate exception flow. |
| `period_expired` | A `BudgetLimit` has `period_end < now` and the limit's `enforcement` is `"hard"`. | Roll the limit forward (new `period_start` / `period_end`) or remove it if no longer applicable. |

## autonomous_bounds gate

Evaluation order (canonical):

1. `bounds_active`
2. `bounds_not_expired`
3. `action_type_permitted`
4. `within_execution_ceiling`
5. `within_daily_aggregate`
6. `within_risk_tier`

| Deny code | Fires when | Operator action |
|---|---|---|
| `inactive` | The agent's `AutonomousExecutionBounds.active` is False. | Re-activate the bounds record after operator review. |
| `expired` | `bounds.expires_at < now`. | Renew the bounds record with a fresh `expires_at`. Bounds expiry is a deliberate forcing function for periodic re-authorization. |
| `action_type_not_permitted` | The action's `action_type` is not in `bounds.permitted_action_types`. | Add the action type to the allowlist (after operator review) or route the action through a non-autonomous path. |
| `execution_ceiling_exceeded` | The action's value exceeds the matching `ExecutionCeiling.per_execution_max`, OR the agent has hit the ceiling's `max_daily_count` for that action type. Both per-execution and per-day limits map to this code; the human-readable `error.reason` distinguishes which one fired. | Reduce value, wait for daily window rollover, or raise the ceiling. |
| `daily_aggregate_exceeded` | `current_daily_aggregate + action_value > bounds.daily_aggregate_ceiling`. | Wait for the daily window or raise the aggregate ceiling. |
| `risk_tier_exceeded` | Action `risk_tier` is strictly above the agent's `max_risk_tier` (ordering: low < medium < high < critical). | Route the action through human approval; agent self-escalation is forbidden by design. |

---

## Lifecycle and stability

- **Deny code strings are wire-stable.** Renaming or removing a deny
  code is a breaking change. New codes can be added in minor releases
  as long as they don't shadow existing ones.
- The deny-code Literal types in both SDKs are exhaustive: callers can
  use TypeScript `switch` / Python `match` over the union with
  exhaustiveness checking. New codes will surface as type errors at the
  call site, which is intentional — enforcement-side branching should
  always be explicit.
- Soft-warning conditions (e.g. budget `enforcement="soft"` overruns)
  do NOT have deny codes. They are observable only via
  `result.soft_warnings` and never raise.
- The `dispute_reversal` and `incentive_alignment` modules do NOT have
  enforcement helpers in this layer. Disputes are state machines, not
  point-in-time gates; incentive alignment is a lagging governance
  health metric, not a per-action authorization decision.
