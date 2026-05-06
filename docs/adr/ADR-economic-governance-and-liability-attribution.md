# ADR: Economic Governance, Liability Attribution, and Autonomous Financial Control

**Status:** Accepted  
**Date:** 2026-05-06  
**Deciders:** AtlaSent Platform Team  
**Branch:** `claude/economic-governance-liability-Sx9zN`

---

## Context

AtlaSent V2 shipped federated governance, runtime verification, cross-org trust networks,
autonomous agent governance, regulatory evidence systems, and enterprise authorization
infrastructure. The next evolution requires governing the *financial consequences* of
agent actions: who is liable when an autonomous agent pays the wrong vendor, how do we
prove a $2M wire transfer was duly authorized, and how do we prevent budget overruns
triggered by orchestration loops?

This ADR records the design decisions for the Economic Governance layer, which sits atop
the existing authorization primitives and adds:

- **Financial Action Model** — canonical vocabulary for consequential financial operations  
- **Liability Attribution Engine** — immutable chain-of-custody for financial consequences
- **Economic Risk Engine** — real-time scoring of organizational financial risk posture
- **Financial Quorum** — monetary-threshold-aware multi-party approval
- **Budgetary Governance** — hard/soft spending limits and constraint enforcement
- **Autonomous Financial Execution** — bounded authority for AI-driven financial actions
- **Incentive Alignment Engine** — detection of governance anti-patterns
- **Economic Evidence Bundles** — signed, auditable proof for regulators and auditors
- **Dispute + Reversal Workflows** — structured remediation for challenged actions
- **Financial Control Dashboard** — operator-facing visibility into governance posture

---

## Decision 1: Liability Attribution Philosophy

### Decision

Every financial action carries an immutable, ordered **liability chain** that assigns a
fractional *liability weight* (0–1, summing to 1.0) to every party who touched the action:
authorizer, delegator(s), delegate(s), approver(s), supervisor(s), executor, and any
override actor.

### Rationale

- Regulators and insurers require traceable accountability, not just audit logs.
  A chain of parties with explicit weights makes that accountability machine-readable.
- Distributed liability (shared, delegated, supervisory) reflects real-world legal
  frameworks more accurately than binary “approver = liable” models.
- Emergency override actors receive the highest default liability weight (0.40 of the
  raw budget before normalization) because overrides represent the highest-risk path.

### Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Single “last approver is liable” | Does not reflect delegation chains or supervisory relationships |
| Equal split across all parties | Ignores the governance role each party played |
| Liability only at execution | Too late — authorization is the consequential decision |

### Liability Classification Regimes

| Classification | Description | Typical Use |
|---|---|---|
| `individual` | One party bears full weight | Sole-authority actions |
| `shared` | Proportional to role weight | Standard multi-approver actions |
| `delegated` | Full weight flows to delegate | When authority is explicitly transferred |
| `supervisory` | Supervisors bear weight for team | Manager-team execution chains |
| `emergency_override` | Override actor receives inflated weight | Emergency bypasses |

---

## Decision 2: Financial Governance Boundaries

### Decision

AtlaSent economic governance is **authorization infrastructure**, not accounting software.
It answers *“was this action properly authorized and who is responsible?”* — not *“what is
the current account balance?”*.

### What AtlaSent Economic Governance Does

- Evaluate whether a financial action meets quorum, budget, and liability requirements
  *before* execution
- Record an immutable evidence trail of who authorized, approved, and executed
- Compute risk scores for governance posture analysis
- Detect misaligned incentives in governance behavior
- Generate signed evidence bundles for regulators, auditors, and insurers
- Manage dispute and reversal *workflows* (state machines), not the underlying
  financial transactions themselves

### What AtlaSent Economic Governance Does NOT Do

- Maintain ledgers, balances, or accounting entries
- Execute wire transfers, payment instructions, or bank API calls
- Implement trading or treasury management systems
- Replace ERP, banking, or payment rail infrastructure
- Own the upstream runtime verification layer (that remains in the core V2 engine)

---

## Decision 3: Economic Authorization Model

### Decision

Financial quorum extends the base quorum model (`ApprovalQuorumV1`) with three
additional layers evaluated in order after the base quorum passes:

1. **Amount threshold escalation** — additional approvals and roles required above
   declared monetary thresholds
2. **Financial role requirements** — mandatory roles (e.g. CFO, security) for
   specific risk tiers or value ranges
3. **Regulator approval** — optional out-of-band regulator token required above a
   declared threshold

Emergency freeze is a hard pre-check that supersedes all other evaluation.

### Risk Tier Thresholds (Default USD)

| Tier | Range | Default Required Approvals |
|---|---|---|
| `low` | < $1,000 | 1 |
| `medium` | $1,000 – $50,000 | 2 |
| `high` | $50,000 – $1,000,000 | 3 (CFO required) |
| `critical` | > $1,000,000 | 4+ (board / regulator review) |

Thresholds are configurable per organization via `FinancialQuorumPolicy.amount_thresholds`.

### Evaluation Order

```
Emergency Freeze? → BLOCK immediately
  ↓ No
Base Quorum (count) → FAIL if below required_count
  ↓ Pass
Amount Threshold Escalation → FAIL if additional requirements unmet
  ↓ Pass
Financial Role Requirements → FAIL if required roles absent
  ↓ Pass
Regulator Approval → FAIL if required but absent
  ↓ Pass
FINANCIAL QUORUM SATISFIED
```

---

## Decision 4: Autonomous Financial Safety

### Decision

Autonomous agents operating on financial actions must be pre-declared with explicit
`AutonomousExecutionBounds` that specify:

- Permitted action types (allowlist, not denylist)
- Per-execution monetary ceilings per action type
- Daily aggregate ceilings across all types
- Maximum risk tier
- Optional daily count limits per action type
- Expiry timestamps for time-bounded authority

Any execution outside these bounds is denied. Agents may not self-escalate or
self-modify their own bounds.

### Anomaly Detection

Runtime anomaly detection checks:

1. **Statistical outlier** — value > 3σ from historical mean for this agent+action type
2. **Execution burst** — count exceeds burst threshold in the observation window
3. **Off-hours + elevated value** — execution outside business hours with above-mean value

Anomaly detection does not block execution automatically — it flags the record for
operator review and feeds into the risk score. Blocking on anomaly requires an
explicit `anomaly_blocks_execution: true` flag on the bounds configuration.

### Rationale

- Blocklist approaches fail because autonomous agents will encounter novel action types.
  Allowlist + ceiling gives a much smaller attack surface.
- Expiring bounds force periodic re-authorization, preventing scope creep over time.
- Anomaly detection is advisory rather than blocking by default to avoid production
  outages from false positives; operators can harden per agent.

---

## Decision 5: Incentive Alignment Framework

### Decision

The incentive alignment engine detects *behavioral patterns* that indicate the governance
process is being gamed or is under stress, even when individual actions are technically
authorized. It produces `IncentiveSignal` objects with severity scores, not policy
decisions.

### Detected Anti-Patterns

| Signal | Threshold (Default) | Interpretation |
|---|---|---|
| `excessive_overrides` | Override rate > 5% | Process friction too high, approvers routing around controls |
| `rushed_approval` | Approval latency < 30s | Rubber-stamping without genuine review |
| `emergency_bypass_repeat` | > 3 per 30 days | Emergency path used as routine workaround |
| `authority_concentration` | One party > 40% of approvals | Single point of failure + collusion risk |
| `delegation_chain_depth` | Depth > 3 | Authority diffused to point of untraceability |

### Governance Health Score

A composite score (0–100) derived from detected signal severities. Used as a lagging
indicator for governance quality trend analysis. Not used for authorization decisions.

### Rationale

- Purely rule-based governance creates adversarial relationships where humans optimize
  for technical compliance rather than genuine oversight.
- Behavioral signals catch governance erosion before it becomes a compliance event.
- Keeping signals advisory (not blocking) respects the separation between governance
  intelligence and authorization enforcement.

---

## Decision 6: Dispute Handling Guarantees

### Decision

Dispute and reversal workflows are modeled as **state machines** with explicit, validated
transitions. Invalid transitions are rejected at the type level. Terminal states
(`resolved_in_favor`, `resolved_against`, `reversed`, `withdrawn`) have no outgoing edges.

### Dispute State Machine

```
open → under_review → escalated → resolved_in_favor
     → withdrawn         → resolved_against
                         → reversed
```

### Reversal State Machine

```
initiated → authorization_pending → authorized → executing → completed
          → cancelled               → cancelled    → cancelled   → failed → initiated (retry)
```

### Guarantees

1. **Reversal requires authorization** — a reversal cannot move to `executing` without
   passing through `authorized`, which requires an AtlaSent permit.
2. **Freezes are time-bounded or indefinite** — there is no concept of an expired-but-not-lifted
   freeze; expiry is checked at runtime.
3. **Dispute records are immutable** — new state is written as a new record, not an update,
   preserving the full state history.
4. **Reversal authority is declared** — the `authorized_by` and `authorization_permit_id`
   fields are required before stage transition to `executing`.

---

## Decision 7: Economic Evidence Bundle Design

### Decision

Evidence bundles follow the same signing protocol as audit export bundles (`auditBundle.ts`):

1. A canonical signable content object is derived from the bundle (sorted keys, no whitespace)
2. A SHA-256 `content_hash` covers the signable content
3. An Ed25519 signature over the content hash is stored in `signature` (base64url)
4. The `signing_key_id` references the active key in the signing key registry

This matches the offline-verifiable pattern used in V1/V2 audit exports, so auditors
can use the same verification toolchain.

### Evidence Purposes

| Purpose | Audience | Typical SLA |
|---|---|---|
| `regulator_review` | Regulatory bodies | As requested / 30-day hold |
| `insurance_review` | Insurance underwriters | On-demand |
| `financial_audit` | Internal/external auditors | Annual + ad-hoc |
| `legal_discovery` | Legal counsel, courts | On subpoena |
| `internal_review` | Security, compliance teams | On-demand |
| `dispute_resolution` | Dispute workflow participants | Per dispute timeline |

---

## Database Schema Summary

The following tables are introduced by this ADR (see `migrations/` for DDL):

| Table | Purpose |
|---|---|
| `financial_action_classes` | Canonical action type definitions with risk tiers |
| `financial_execution_records` | Immutable execution audit trail |
| `liability_attribution_records` | Per-execution liability chain |
| `financial_risk_scores` | Computed risk scores (append-only) |
| `financial_quorum_policies` | Quorum policy definitions |
| `emergency_freezes` | Org/scope freeze records |
| `budget_policies` | Budget policy documents |
| `budget_limits` | Declared spending limits |
| `spending_constraints` | Per-action-type constraints |
| `autonomous_execution_bounds` | Agent authority declarations |
| `autonomous_execution_records` | Agent execution audit trail |
| `incentive_signals` | Detected governance anti-patterns |
| `economic_evidence_bundles` | Signed evidence bundle metadata |
| `dispute_records` | Financial action disputes |
| `reversal_workflows` | Reversal state machine records |
| `action_freezes` | Per-execution freeze records |

---

## Consequences

### Positive

- AtlaSent becomes authorization-to-act infrastructure for consequential financial actions,
  not just agent identity verification.
- Liability chains make regulatory examinations significantly faster — auditors can
  query the chain rather than reconstructing it from disparate logs.
- Financial quorum integrates seamlessly with the existing approval quorum layer;
  no parallel approval mechanism is introduced.
- Incentive signals provide early warning of governance erosion before it becomes
  a compliance event.
- Evidence bundles use the same offline-verification toolchain as existing audit exports.

### Negative / Trade-offs

- Additional tables and indexes increase database footprint. Mitigation: append-only
  design enables aggressive table partitioning by org_id + created_at.
- Liability weight computation (role-weighted normalization) introduces a non-deterministic
  element when multiple parties share the same role. Mitigation: weights are computed at
  record creation time and stored immutably; recalculation is never needed.
- Evidence bundle generation is synchronous and may add latency to post-execution workflows.
  Mitigation: bundle generation is decoupled from the execution path; it runs async after
  execution is confirmed.

### Non-Goals (Reaffirmed)

- No accounting system, ledger, or balance management
- No banking API integration
- No trading system implementation
- No redesign of V2 runtime verification or federated governance core
- No replacement of existing approval quorum infrastructure

---

## References

- `typescript/src/financialAction.ts` — Phase 1: Financial Action Model
- `typescript/src/liabilityAttribution.ts` — Phase 2: Liability Attribution Engine
- `typescript/src/economicRisk.ts` — Phase 3: Economic Risk Engine
- `typescript/src/financialQuorum.ts` — Phase 4: Financial Quorum
- `typescript/src/budgetaryGovernance.ts` — Phase 5: Budgetary Governance
- `typescript/src/autonomousFinancial.ts` — Phase 6: Autonomous Financial Execution
- `typescript/src/incentiveAlignment.ts` — Phase 7: Incentive Alignment Engine
- `typescript/src/economicEvidence.ts` — Phase 8: Economic Evidence Bundles
- `typescript/src/disputeReversal.ts` — Phase 9: Dispute + Reversal Workflows
- `typescript/src/financialDashboard.ts` — Phase 10: Financial Control Dashboard
- `migrations/` — SQL DDL for all tables
- `contract/schemas/` — JSON Schema for wire-stable types
