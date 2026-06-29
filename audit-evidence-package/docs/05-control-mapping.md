# Control mapping — SOC 2, 21 CFR Part 11, EU Annex 11, GxP

How a verified evidence bundle maps onto the controls auditors actually test.
Each row states **what the proof demonstrates** and, honestly, **what it does
not** cover (so you can scope the rest of your testing).

> Bring **one** mapped clause to a verification session, not the whole table.
> The goal is a single accepted control, not a framework tour.

## SOC 2 (Trust Services Criteria)

| Criterion | What a verified bundle demonstrates | What it does not cover |
|---|---|---|
| **CC7.2** — system monitoring detects anomalies / unauthorized changes | Each consequential action's authorization decision is recorded in a tamper-evident chain; an unauthorized or denied attempt is itself an immutable, signed record. | Detection *coverage* (that all relevant actions are gated) is a design question — verify the integration scope separately. |
| **CC8.1** — changes are authorized, tested, approved before implementation | The decision record binds the change (`decision_id`, context) to an `allow`/`deny`, signed and ordered. Tamper-evidence means the authorization can't be back-dated or edited. | That the *executed* change matched the authorized one (use runtime-execution evidence); policy correctness. |
| **CC6.1 / CC6.3** — logical access is restricted and authorized | Decisions reflect access-control enforcement at execution time, recorded with integrity. | Provisioning correctness and identity lifecycle (separate controls). |

## 21 CFR Part 11 (FDA electronic records / signatures)

| Clause | What a verified bundle demonstrates | Notes |
|---|---|---|
| **§11.10(a)** — validation; ability to discern altered records | Verification *is* the alteration check: any change fails. | Pair with system validation evidence. |
| **§11.10(b)** — accurate & complete copies for inspection | The bundle is a self-contained, independently-checkable copy; a "certified copy" mode embeds record counts + chain head. | "Complete" across the full window is the anchoring question (see threat model #3). |
| **§11.10(c)** — protection of records over the retention period | Tamper-evidence + offline verifiability mean archived bundles remain checkable for their lifetime with only a public key. | Retention/archival storage is operational, outside the proof. |
| **§11.10(e)** — secure, computer-generated, time-stamped audit trail; capture changes | The hash-linked chain is exactly such an audit trail; reason-for-change, where supplied, is bound into the signed record. | — |
| **§11.50 / §11.70** — signature manifestations; signature/record linking | Where a decision rests on a human approval, the approval's meaning and identity binding travel as a verifiable artifact linked to the record. | Assess the approval artifact's signature on its own merits (threat model #4). |

## EU Annex 11 (computerised systems)

| Clause | What a verified bundle demonstrates | Notes |
|---|---|---|
| **§9** — audit trails for GMP-relevant changes | The signed hash chain is a tamper-evident audit trail of authorization decisions. | — |
| **§12** — access control | Decisions record execution-time authorization outcomes with integrity. | Account/role management is separate. |
| **§8** — data integrity (accuracy, completeness) | Integrity and order are cryptographically enforced; the Merkle summary commits to the exact record set. | Completeness across windows: anchoring. |
| **§17** — archiving | Bundles remain verifiable from cold storage with only the public trust root. | Storage durability is operational. |

## GxP (general)

| Expectation | What a verified bundle demonstrates |
|---|---|
| **ALCOA+** (Attributable, Legible, Contemporaneous, Original, Accurate, + Complete, Consistent, Enduring, Available) | *Attributable* (signed by a named authority; approver identity via linked artifacts), *Original/Accurate* (tamper-evident), *Contemporaneous* (recorded before the response is returned, time-stamped), *Enduring/Available* (offline-verifiable indefinitely with a public key), *Consistent* (chained order). *Complete* across the full history relies on anchoring. |

## How to use this in a review

1. Pick the single clause your control is actually testing.
2. Run `./verify.sh` on a **real** bundle from the regulated org and confirm PASS.
3. Map the PASS to the "demonstrates" column for that clause.
4. Note the "does not cover" column as the boundary of this evidence, and cite
   where the remaining assurance comes from (policy review, runtime-execution
   evidence, anchoring, identity artifacts).

The honest framing — "here is exactly what the cryptography buys you, and here is
where other evidence takes over" — is what makes the control defensible.
