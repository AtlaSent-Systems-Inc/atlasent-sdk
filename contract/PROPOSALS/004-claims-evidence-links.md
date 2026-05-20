# Proposal 004 — Claims → Evidence Lineage

**Status:** `DRAFT`
**Needs decisions from:** API team (endpoint ownership, server-side delta
computation), security team (signature verification scope), data team
(retention / queryability of link objects).

---

## Problem statement

AtlaSent currently produces several kinds of evidence artifacts in
isolation:

| Artifact | Produced by | Wire type |
|---|---|---|
| `DecisionReceipt` | `protectWithEvidence()` | _(SDK-local, no schema)_ |
| `EconomicEvidenceBundle` | financial vertical | `economic_evidence.v1` |
| `ComplianceEvidenceRun` | `/v1/compliance-evidence` | _(API-local)_ |
| `ApprovalArtifact` / HITL chain | `/v1/hitl` | `approval_artifact.v1` |

A *canonical claim* (a durable assertion that a particular policy state
held at a specific time) can reference any of these, but today there is
no standard way to express which evidence supports which claim, whether
all mandatory evidence slots have been filled, or whether the evidence
is still valid relative to the current policy version.

Concretely:

- An auditor reviewing a `claims` table cannot tell from the row itself
  whether the underlying permit was verified, what compliance controls
  passed, or which humans approved the action.
- A policy-drift event (policy updated after the claim was made) is
  invisible until an auditor manually re-evaluates.
- Evidence completeness is checked ad-hoc by each consumer rather than
  by a shared machine-readable checklist.

This proposal introduces `ClaimEvidenceLink` — a wire-stable artifact
that ties a canonical claim to its full evidence lineage and provides a
machine-auditable verification checklist.

---

## Proposed wire format

### `ClaimEvidenceLink` object (top level)

```jsonc
{
  "version": "claim_evidence_link.v1",         // discriminator — never changes
  "link_id": "cel_01j9...",                    // server-assigned stable ID
  "claim_id": "claim_01j8...",                 // the canonical claim this annotates
  "org_id": "org_abc",
  "linked_at": "2026-05-20T10:00:00Z",         // ISO 8601
  "runtime_evidence": { ... },                 // required; see sub-schema below
  "deploy_evidence":  { ... } | null,          // required field, nullable slot
  "integration_evidence": { ... } | null,
  "approval_artifact": { ... } | null,
  "delta": { ... },                            // required; computed at link creation
  "verification_checklist": { ... }            // required; machine-auditable summary
}
```

All six top-level slots are **required fields** in the schema (the
nullable slots carry `null` when the evidence type does not apply to
this claim — e.g. a non-financial action has no `deploy_evidence`).
This is intentional: a missing field means the link was not built
correctly, while `null` means "not applicable and that was decided
explicitly."

### `runtime_evidence` — always required, never null

Derived from the `DecisionReceipt` produced by `protectWithEvidence()`.
Contains the minimum fields needed to re-verify the permit offline.

```jsonc
{
  "permit_token": "tok_...",       // from /v1-verify-permit
  "audit_hash": "a1b2c3...",       // 64 hex chars (SHA-256)
  "decision": "allow",            // "allow" | "deny" | "escalate"
  "decision_id": "dec_...",
  "evaluated_at": "2026-05-20T09:59:55Z",
  "algorithm": "hmac-sha256",     // signing algorithm for the receipt
  "signature": "base64url..."     // null when no signing secret configured
}
```

### `deploy_evidence` — null when not a deployment action

Populated from `protectDeploy()` gate output.

```jsonc
{
  "deploy_id": "deploy_01j9...",
  "environment": "production",
  "sha": "a3f9bc...",
  "actor_id": "user-ci-runner",
  "deployed_at": "2026-05-20T10:00:00Z",
  "gate_permit_token": "tok_..."   // the permit token from the deploy gate
}
```

### `integration_evidence` — null when compliance run not linked

Summary of the most recent `ComplianceEvidenceRun` covering the claim
period. Full run details remain in `/v1/compliance-evidence`; this
carries enough to answer "was the org compliant when this claim was
made?"

```jsonc
{
  "run_id": "run_...",
  "framework": "soc2",            // "soc2" | "iso27001" | "hipaa" | "pci_dss"
  "period_start": "2026-04-01",
  "period_end": "2026-06-30",
  "status": "completed",
  "passing_control_count": 48,
  "failing_control_count": 0,
  "run_completed_at": "2026-05-19T23:00:00Z"
}
```

### `approval_artifact` — null when no human approval required

Summarises the HITL chain or `ApprovalArtifact`. Not a full copy of
the artifact (those are large); carries the audit-relevant fields.

```jsonc
{
  "approval_id": "apr_...",
  "approval_kind": "hitl_chain",   // "hitl_chain" | "approval_artifact"
  "quorum_type": "simple_majority",
  "approver_count": 2,
  "approver_ids": ["user-cfo", "user-fm"],
  "approved_at": "2026-05-20T09:55:00Z"
}
```

### `delta` — policy and schema drift since claim was made

The delta slot answers: "has anything material changed since the claim
was asserted that would affect re-evaluation?"

```jsonc
{
  "computed_at": "2026-05-20T10:00:00Z",
  "policy_version_at_claim": "pol_v42",
  "policy_version_current": "pol_v42",
  "policy_drift_detected": false,
  "schema_version_at_claim": "openapi-2.14.0",
  "schema_version_current": "openapi-2.14.0",
  "schema_drift_detected": false,
  "drift_details": []             // array of human-readable change strings when drift detected
}
```

`drift_details` carries strings like `"rule 'deny_unvetted_agent'
removed since claim was made"` to guide a human reviewer without
requiring them to diff policy YAML manually.

### `verification_checklist` — machine-auditable summary

```jsonc
{
  "runtime_evidence_present": true,
  "runtime_evidence_verified": true,   // permit_token still valid per /v1-verify-permit
  "deploy_evidence_present": true,     // false when slot is null (not applicable)
  "integration_evidence_present": true,
  "approval_artifact_present": true,
  "delta_computed": true,
  "policy_drift_clean": true,          // !delta.policy_drift_detected
  "schema_drift_clean": true,
  "all_pass": true,                    // AND of all boolean fields above
  "computed_at": "2026-05-20T10:00:00Z"
}
```

`all_pass` is the top-level boolean an automated auditor queries.
Individual fields let a reviewer pinpoint exactly which slot failed.

### Full example

```json
{
  "version": "claim_evidence_link.v1",
  "link_id": "cel_01j9abc",
  "claim_id": "claim_01j8xyz",
  "org_id": "org-acme",
  "linked_at": "2026-05-20T10:00:01Z",
  "runtime_evidence": {
    "permit_token": "tok_01j9abc",
    "audit_hash": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "decision": "allow",
    "decision_id": "dec_01j8xyz",
    "evaluated_at": "2026-05-20T09:59:55Z",
    "algorithm": "hmac-sha256",
    "signature": "dGhpcyBpcyBhIHRlc3Q"
  },
  "deploy_evidence": null,
  "integration_evidence": {
    "run_id": "run_01j7pqr",
    "framework": "soc2",
    "period_start": "2026-04-01",
    "period_end": "2026-06-30",
    "status": "completed",
    "passing_control_count": 48,
    "failing_control_count": 0,
    "run_completed_at": "2026-05-19T23:00:00Z"
  },
  "approval_artifact": {
    "approval_id": "apr_01j8mno",
    "approval_kind": "hitl_chain",
    "quorum_type": "simple_majority",
    "approver_count": 2,
    "approver_ids": ["user-cfo", "user-fm"],
    "approved_at": "2026-05-20T09:55:00Z"
  },
  "delta": {
    "computed_at": "2026-05-20T10:00:01Z",
    "policy_version_at_claim": "pol_v42",
    "policy_version_current": "pol_v42",
    "policy_drift_detected": false,
    "schema_version_at_claim": "openapi-2.14.0",
    "schema_version_current": "openapi-2.14.0",
    "schema_drift_detected": false,
    "drift_details": []
  },
  "verification_checklist": {
    "runtime_evidence_present": true,
    "runtime_evidence_verified": true,
    "deploy_evidence_present": false,
    "integration_evidence_present": true,
    "approval_artifact_present": true,
    "delta_computed": true,
    "policy_drift_clean": true,
    "schema_drift_clean": true,
    "all_pass": true,
    "computed_at": "2026-05-20T10:00:01Z"
  }
}
```

---

## Open questions

1. **Server-assigned vs. client-generated `link_id`.** The proposal
   assumes `link_id` is server-assigned (requiring a new API endpoint
   or the server to return it as part of a `protectWithEvidence()`
   response). If links are purely offline client artifacts, `link_id`
   can be a client-generated UUID and there is no endpoint. Decision
   needed from the **API team**: is `ClaimEvidenceLink` a persisted
   server resource (with CRUD), or a signed offline artifact?

2. **Delta computation ownership.** `policy_version_at_claim` and drift
   detection require knowing what policy was active when the claim was
   made. Only the server has this information. If links are offline
   artifacts, the `delta` slot must be server-populated (either at
   claim time or on demand via a dedicated endpoint). **API team**:
   who calls the delta computation, and when?

3. **`runtime_evidence_verified` staleness.** The checklist field
   `runtime_evidence_verified` implies that the permit token was
   re-verified via `/v1-verify-permit` at `computed_at`. Permit tokens
   have a TTL; an archived link may show `verified: true` but the
   token has since expired. Should the schema carry a
   `verified_until` timestamp, or is `computed_at` sufficient as the
   verification timestamp? **Security team** to advise.

4. **Evidence slots by reference vs. by summary.** This proposal
   embeds a *summary* of each evidence artifact (not the full object)
   to keep links small and wire-stable. Full artifacts remain
   fetchable via their own endpoints. Alternative: carry only IDs and
   let consumers fetch. The summary approach is preferred here because
   it makes links self-contained for offline audit. **API team** to
   confirm the size/completeness trade-off is acceptable.

5. **`deploy_evidence_present` when slot is null.** The verification
   checklist sets `deploy_evidence_present: false` when
   `deploy_evidence` is null. But "not applicable" and "missing" are
   semantically different. Should there be a third state
   (`"not_applicable"`) for each slot? A boolean loses this
   distinction. **Data team** to advise based on auditor UX
   requirements.

6. **Drift details encoding.** `drift_details` is currently an array
   of human-readable strings. Machine-parseable diff objects (e.g.,
   `{ "type": "rule_removed", "rule_id": "deny_unvetted_agent" }`)
   would let downstream systems auto-classify drift severity without
   NLP. **API team** to decide on string vs. structured objects.

---

## SDK-side implementation sketch

Once the proposal is `ACCEPTED` and open questions 1–2 are resolved,
the SDK adds a new module `src/claimLineage.ts`:

### TypeScript public surface

```typescript
// src/claimLineage.ts

export interface RuntimeEvidenceSlot { ... }   // mirrors schema sub-object
export interface DeployEvidenceSlot { ... }
export interface IntegrationEvidenceSlot { ... }
export interface ApprovalArtifactSlot { ... }
export interface DeltaSlot { ... }
export interface VerificationChecklist { ... }

export interface ClaimEvidenceLink {
  version: "claim_evidence_link.v1";
  link_id: string;
  claim_id: string;
  org_id: string;
  linked_at: string;
  runtime_evidence: RuntimeEvidenceSlot;
  deploy_evidence: DeployEvidenceSlot | null;
  integration_evidence: IntegrationEvidenceSlot | null;
  approval_artifact: ApprovalArtifactSlot | null;
  delta: DeltaSlot;
  verification_checklist: VerificationChecklist;
}

/**
 * Assemble a ClaimEvidenceLink from already-fetched SDK artifacts.
 * Does not make network calls; the caller is responsible for
 * supplying each slot or null.
 */
export function buildClaimEvidenceLink(
  claimId: string,
  slots: {
    runtimeEvidence: DecisionReceipt;
    deployEvidence?: DeployGateResult | null;
    integrationEvidence?: ComplianceEvidenceRun | null;
    approvalArtifact?: HitlChain | ApprovalArtifact | null;
  },
): Omit<ClaimEvidenceLink, "link_id" | "delta" | "linked_at">;
// Note: link_id and delta are server-assigned; this builds the
// client-constructable portion only (pending resolution of OQ 1-2).

/**
 * Verify the checklist of a ClaimEvidenceLink received from the server.
 * Re-checks runtime_evidence_verified by calling /v1-verify-permit if
 * a client is configured.
 */
export async function verifyClaimEvidenceLink(
  link: ClaimEvidenceLink,
  opts?: { client?: AtlaSentClient; skipPermitRecheck?: boolean },
): Promise<{ valid: boolean; failedSlots: string[]; reason?: string }>;
```

### Python surface

```python
# atlasent/governance/claim_lineage.py
from dataclasses import dataclass

@dataclass(frozen=True)
class ClaimEvidenceLink:
    version: Literal["claim_evidence_link.v1"]
    link_id: str
    claim_id: str
    org_id: str
    linked_at: str
    runtime_evidence: RuntimeEvidenceSlot
    deploy_evidence: DeployEvidenceSlot | None
    integration_evidence: IntegrationEvidenceSlot | None
    approval_artifact: ApprovalArtifactSlot | None
    delta: DeltaSlot
    verification_checklist: VerificationChecklist

def build_claim_evidence_link(
    claim_id: str,
    *,
    runtime_evidence: DecisionReceipt,
    deploy_evidence: DeployGateResult | None = None,
    integration_evidence: ComplianceEvidenceRun | None = None,
    approval_artifact: HitlChain | ApprovalArtifact | None = None,
) -> ClaimEvidenceLink: ...

async def verify_claim_evidence_link(
    link: ClaimEvidenceLink,
    *,
    client: AtlaSentClient | None = None,
    skip_permit_recheck: bool = False,
) -> tuple[bool, list[str]]: ...
```

### Error additions

One new error code added to `AtlaSentErrorCode`:

- `"claim_evidence_incomplete"` — raised by `verifyClaimEvidenceLink`
  when `all_pass` is false. Carries `failedSlots: string[]` so the
  caller can surface exactly which evidence is missing.

No new HTTP error codes; this surfaces as an SDK-level validation
error, not a server rejection.

---

## Test vector requirements

Once the proposal is `ACCEPTED` and the schema is committed to
`contract/schemas/claim-evidence-link.schema.json`, the following
fixtures go under `contract/vectors/claim-evidence-link/`:

| File | What it exercises |
|---|---|
| `valid-all-slots.json` | All 6 slots populated; `all_pass: true` |
| `valid-no-deploy.json` | `deploy_evidence: null`; `deploy_evidence_present: false`; `all_pass: true` (deploy not required) |
| `valid-no-approval.json` | `approval_artifact: null`; non-financial action requiring no HITL |
| `invalid-missing-runtime.json` | `runtime_evidence` absent — schema validation error |
| `drift-detected.json` | `delta.policy_drift_detected: true`; `all_pass: false`; `drift_details` non-empty |
| `permit-expired.json` | `runtime_evidence_verified: false` (permit TTL elapsed) |

Negative fixtures (`invalid-*`) must fail JSON Schema validation.
Positive fixtures (`valid-*`, `drift-*`, `permit-*`) must pass schema
validation but may have `all_pass: false` (schema-valid links can
still fail the audit checklist).

The existing `contract/tools/validate_vectors.py` will be extended to
load and validate all `claim-evidence-link/` fixtures once the schema
lands.
