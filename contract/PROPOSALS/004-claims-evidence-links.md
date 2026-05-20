# Proposal 004 — Claims → Evidence Lineage

**Status:** `ACCEPTED`
**Resolved by:** API team (Priya + Darius), Security team (Amara + Jonas),
Data team (Remi + Saoirse) — see _Team review resolutions_ section below.

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

This proposal introduces `ClaimEvidenceLink` — a signed, wire-stable
artifact that ties a canonical claim to its full evidence lineage and
provides a machine-auditable verification checklist.

---

## Team review resolutions

The following items were raised in cross-team review and are resolved
below. All 12 blocking items are closed; the proposal advances to
`ACCEPTED`.

### API team (Priya + Darius)

**R1 — Offline artifact, not a server resource (for v1).**
`link_id` is client-generated using a `cel_`-prefixed UUID v7 (time-ordered).
No new API endpoints in v1. The delta's policy-drift fields are populated
server-side asynchronously; the link ships with `delta.status: "pending"`
until the server fills it in via a background job or the caller explicitly
requests computation. A dedicated `/v1/claim-evidence-links/:id/compute-delta`
endpoint is scoped for v2.

**R2 — `delta.status` async field.**
`delta` now carries a `status: "pending" | "computing" | "computed" | "failed"`
field. Policy-drift fields (`policy_version_at_claim`, `policy_version_current`,
`policy_drift_detected`) are nullable until `status === "computed"`. Schema-drift
fields (`schema_version_*`, `schema_drift_detected`) are always populated by the
client at link creation. `delta_computed` in the checklist mirrors
`delta.status === "computed"`, so `all_pass` can only be true once the server
has computed policy drift.

**R3 — Link creation is opt-in.**
`protectWithEvidence()` does not automatically build a link.
`buildClaimEvidenceLink()` is a separate, explicit SDK call the application
makes after it has assembled all relevant evidence slots.

### Security team (Amara + Jonas)

**R4 — Link is signed.**
`link_hash` (SHA-256 of the canonical link, excluding `link_hash` and
`link_signature`) and `link_signature` (HMAC-SHA256 or Ed25519 over
`link_hash`, null when `link_algorithm: "none"`) are now required top-level
fields. Canonical serialization follows the same sorted-key, no-whitespace
algorithm used by `economicEvidence.ts`. Any mutation to any slot changes
the hash. `revision` increments on each mutation and the hash is
recomputed, making per-revision tampering detectable.

**R5 — Split `runtime_evidence_verified` into two immutable + mutable fields.**
`runtime_evidence` now carries:
- `verified_at_claim_time: boolean` — immutable; true iff `decision === "allow"`.
  Answers "was the action authorized at the time it happened?" Never changes.
- `verified_at_link_creation: boolean` — mutable; true iff `permit_token` was
  successfully re-verified at `linked_at`. Updated by `verifyClaimEvidenceLink()`
  on subsequent calls.

The checklist mirrors both fields explicitly.

**R6 — `permit_revoked_at` on `runtime_evidence`.**
`permit_revoked_at: string (date-time) | null` added. Null when the permit
is valid or expired (TTL lapse). Populated when the SDK detects revocation
during re-verification or receives a `PermitRevoked` event. When non-null,
`verified_at_link_creation` is set to `false` on the same revision.

**R7 — `artifact_hash` on `approval_artifact`.**
`artifact_hash: string (64 hex chars)` added as a required field on the
`approval_artifact` slot. SHA-256 of the canonical encoding of the full
`ApprovalArtifact` or `HitlChain` object. Allows an auditor to re-fetch
the full artifact and verify the summary was not tampered with.

**R8 — `drift_details` is structured, not strings.**
Each element of `drift_details` is now an object with:
- `change_type`: enum (`rule_added`, `rule_removed`, `rule_modified`,
  `threshold_changed`, `policy_updated`, `schema_field_added`,
  `schema_field_removed`, `schema_field_type_changed`)
- `severity`: enum (`info`, `warning`, `critical`)
- `rule_id`: string | null
- `changed_at`: date-time | null
- `description`: string (human-readable; not the machine key)

This enables automated severity routing in SIEM and PagerDuty without
regex parsing.

### Data team (Remi + Saoirse)

**R9 — Three-state enum for nullable evidence slots.**
`deploy_evidence_present`, `integration_evidence_present`,
`approval_artifact_present` (booleans) are replaced with:
- `deploy_evidence_status: "present" | "not_applicable" | "missing"`
- `integration_evidence_status: "present" | "not_applicable" | "missing"`
- `approval_artifact_status: "present" | "not_applicable" | "missing"`

`"not_applicable"` = caller explicitly declared this evidence type does
not apply. `"missing"` = evidence was expected but could not be supplied.
Only `"missing"` gates `all_pass`. `"not_applicable"` does not.

**R10 — `last_verified_at` on checklist.**
`verification_checklist.last_verified_at: string (date-time) | null` added.
Records when the permit was most recently re-verified, separate from
`computed_at` (when the checklist was last refreshed). A checklist refresh
that recomputes drift without re-verifying the permit (e.g. permit is expired)
updates `computed_at` but not `last_verified_at`.

**R11 — References by default; embedded summaries for offline use.**
The slots carry the minimum fields needed for offline audit (no full
artifact embedding). Full artifact fetch uses the existing per-resource
endpoints. An `?expand=` query parameter on the v2 server endpoint will
embed full artifacts when needed; that is out of scope for v1.

**R12 — `updated_at` + `revision` for CDC pipelines.**
`updated_at` (date-time, equals `linked_at` at creation) and
`revision` (integer, starts at 1) are added to the top-level link.
Cardinality: **one mutable link per claim**. The same `link_id` is
updated in place; `revision` increments and `link_hash`/`link_signature`
are recomputed on each mutation. CDC consumers use `revision` for
optimistic locking.

---

## Proposed wire format

Schema: `contract/schemas/claim-evidence-link.schema.json`
(JSON Schema draft-2020-12, `additionalProperties: false` throughout)

### Top-level structure

```jsonc
{
  "version": "claim_evidence_link.v1",   // discriminator
  "link_id": "cel_01j9abc",              // client-generated, cel_ prefix + UUID v7
  "claim_id": "claim_01j8xyz",
  "org_id": "org-acme",
  "linked_at": "2026-05-20T10:00:00Z",   // immutable
  "updated_at": "2026-05-20T12:30:00Z",  // changes on each revision
  "revision": 2,                          // starts at 1, increments per mutation
  "link_algorithm": "hmac-sha256",
  "link_hash": "a1b2c3...64hexchars",    // SHA-256 of canonical link (excl. hash+sig)
  "link_signature": "base64url...",      // null when link_algorithm = "none"
  "runtime_evidence": { ... },
  "deploy_evidence": null,
  "integration_evidence": { ... },
  "approval_artifact": { ... },
  "delta": { ... },
  "verification_checklist": { ... }
}
```

### `runtime_evidence`

```jsonc
{
  "permit_token": "tok_01j9abc",
  "audit_hash": "a1b2c3...64hexchars",
  "decision": "allow",
  "decision_id": "dec_01j8xyz",
  "evaluated_at": "2026-05-20T09:59:55Z",
  "algorithm": "hmac-sha256",
  "signature": "dGhpcyBpcyBhIHRlc3Q",
  "permit_revoked_at": null,             // populated when permit is explicitly revoked
  "verified_at_claim_time": true,        // immutable; true iff decision = "allow"
  "verified_at_link_creation": true      // mutable; updated on re-verification
}
```

### `deploy_evidence` — null for non-deployment claims

```jsonc
{
  "deploy_id": "deploy_01j9...",
  "environment": "production",
  "sha": "a3f9bc...",
  "actor_id": "user-ci-runner",
  "deployed_at": "2026-05-20T10:00:00Z",
  "gate_permit_token": "tok_..."
}
```

### `integration_evidence` — null when no compliance run linked

```jsonc
{
  "run_id": "run_01j7pqr",
  "framework": "soc2",
  "period_start": "2026-04-01",
  "period_end": "2026-06-30",
  "status": "completed",
  "passing_control_count": 48,
  "failing_control_count": 0,
  "run_completed_at": "2026-05-19T23:00:00Z"
}
```

### `approval_artifact` — null when no human approval required

```jsonc
{
  "approval_id": "apr_01j8mno",
  "approval_kind": "hitl_chain",
  "quorum_type": "simple_majority",
  "approver_count": 2,
  "approver_ids": ["user-cfo", "user-fm"],
  "approved_at": "2026-05-20T09:55:00Z",
  "artifact_hash": "b2c3d4...64hexchars"   // SHA-256 of full artifact encoding
}
```

### `delta`

```jsonc
// At link creation (policy drift not yet computed):
{
  "status": "pending",
  "computed_at": null,
  "policy_version_at_claim": null,
  "policy_version_current": null,
  "policy_drift_detected": null,
  "schema_version_at_claim": "@atlasent/sdk@1.4.2",
  "schema_version_current": "@atlasent/sdk@1.4.2",
  "schema_drift_detected": false,
  "drift_details": []
}

// After server-side computation:
{
  "status": "computed",
  "computed_at": "2026-05-20T10:05:00Z",
  "policy_version_at_claim": "pol_v42",
  "policy_version_current": "pol_v43",
  "policy_drift_detected": true,
  "schema_version_at_claim": "@atlasent/sdk@1.4.2",
  "schema_version_current": "@atlasent/sdk@1.4.2",
  "schema_drift_detected": false,
  "drift_details": [
    {
      "change_type": "rule_removed",
      "severity": "critical",
      "rule_id": "deny_unvetted_agent",
      "changed_at": "2026-05-20T08:00:00Z",
      "description": "Rule 'deny_unvetted_agent' was removed in pol_v43. This rule would have affected this claim's action_type."
    }
  ]
}
```

### `verification_checklist`

```jsonc
{
  "runtime_evidence_present": true,
  "verified_at_claim_time": true,
  "verified_at_link_creation": true,
  "deploy_evidence_status": "not_applicable",
  "integration_evidence_status": "present",
  "approval_artifact_status": "present",
  "delta_computed": true,
  "policy_drift_clean": true,
  "schema_drift_clean": true,
  "all_pass": true,
  "last_verified_at": "2026-05-20T10:00:00Z",
  "computed_at": "2026-05-20T10:05:00Z"
}
```

### Full example (post-delta-computation, all slots populated)

```json
{
  "version": "claim_evidence_link.v1",
  "link_id": "cel_01j9abc123",
  "claim_id": "claim_01j8xyz456",
  "org_id": "org-acme",
  "linked_at": "2026-05-20T10:00:00Z",
  "updated_at": "2026-05-20T10:05:00Z",
  "revision": 2,
  "link_algorithm": "hmac-sha256",
  "link_hash": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "link_signature": "dGhpcyBpcyBhIHRlc3Q",
  "runtime_evidence": {
    "permit_token": "tok_01j9abc",
    "audit_hash": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "decision": "allow",
    "decision_id": "dec_01j8xyz",
    "evaluated_at": "2026-05-20T09:59:55Z",
    "algorithm": "hmac-sha256",
    "signature": "dGhpcyBpcyBhIHRlc3Q",
    "permit_revoked_at": null,
    "verified_at_claim_time": true,
    "verified_at_link_creation": true
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
    "approved_at": "2026-05-20T09:55:00Z",
    "artifact_hash": "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3"
  },
  "delta": {
    "status": "computed",
    "computed_at": "2026-05-20T10:05:00Z",
    "policy_version_at_claim": "pol_v42",
    "policy_version_current": "pol_v42",
    "policy_drift_detected": false,
    "schema_version_at_claim": "@atlasent/sdk@1.4.2",
    "schema_version_current": "@atlasent/sdk@1.4.2",
    "schema_drift_detected": false,
    "drift_details": []
  },
  "verification_checklist": {
    "runtime_evidence_present": true,
    "verified_at_claim_time": true,
    "verified_at_link_creation": true,
    "deploy_evidence_status": "not_applicable",
    "integration_evidence_status": "present",
    "approval_artifact_status": "present",
    "delta_computed": true,
    "policy_drift_clean": true,
    "schema_drift_clean": true,
    "all_pass": true,
    "last_verified_at": "2026-05-20T10:00:00Z",
    "computed_at": "2026-05-20T10:05:00Z"
  }
}
```

---

## Open questions

All six original open questions are resolved. No remaining blocking items.

| # | Question | Resolution |
|---|---|---|
| OQ1 | Server-assigned vs. client-generated `link_id` | **Offline / client-generated** for v1. Server resource deferred to v2. |
| OQ2 | Delta computation ownership | **Split**: client computes schema drift at creation; server computes policy drift async. `delta.status` tracks readiness. |
| OQ3 | `runtime_evidence_verified` staleness | **Split into two fields**: `verified_at_claim_time` (immutable) and `verified_at_link_creation` (mutable). `last_verified_at` on checklist records freshness. |
| OQ4 | Embedded summaries vs. references | **Summaries for offline audit** in v1. `?expand=` API param deferred to v2. |
| OQ5 | "not applicable" vs. "missing" for null slots | **Three-state enum** (`"present"` / `"not_applicable"` / `"missing"`). Only `"missing"` gates `all_pass`. |
| OQ6 | `drift_details` string vs. structured | **Structured objects** from day one: `change_type` enum + `severity` enum + `rule_id` + `changed_at` + `description`. |

---

## SDK-side implementation

### New error code

`"claim_evidence_incomplete"` added to `AtlaSentErrorCode`. Thrown by
`verifyClaimEvidenceLink()` when `all_pass` is false. Carries
`failedSlots: string[]` naming each checklist field that failed.

### TypeScript — `src/claimLineage.ts`

```typescript
import type { AtlaSentClient } from "./client.js";
import type { DecisionReceipt } from "./protect.js";
import type { ComplianceEvidenceRun } from "./complianceEvidence.js";

// Evidence slot option types — "not_applicable" explicitly declared,
// undefined means "missing" (expected but not provided).
type SlotInput<T> = T | { notApplicable: true } | undefined;

export interface BuildClaimEvidenceLinkOpts {
  /** The canonical claim ID this link annotates. */
  claimId: string;
  /** DecisionReceipt from protectWithEvidence(). Required. */
  runtimeEvidence: DecisionReceipt;
  /** From protectDeploy(). Pass { notApplicable: true } for non-deployment actions. */
  deployEvidence?: SlotInput<DeployGateResult>;
  /** Most recent ComplianceEvidenceRun covering the claim period. */
  integrationEvidence?: SlotInput<ComplianceEvidenceRun>;
  /** HITL chain or ApprovalArtifact. Pass { notApplicable: true } if no human approval needed. */
  approvalArtifact?: SlotInput<HitlChain | ApprovalArtifact>;
  /** HMAC key or Ed25519 private key for link_signature. Omit for link_algorithm: "none". */
  signingSecret?: string | CryptoKey;
}

/**
 * Assemble a ClaimEvidenceLink from available SDK artifacts.
 *
 * Computes link_hash and link_signature locally. Sets delta.status to
 * "pending" (policy drift must be computed server-side). Callers that
 * want a fully-computed delta must call the server's compute-delta
 * endpoint after creation (v2; out of scope here).
 */
export async function buildClaimEvidenceLink(
  opts: BuildClaimEvidenceLinkOpts,
): Promise<ClaimEvidenceLink>;

/**
 * Verify the integrity and freshness of a ClaimEvidenceLink.
 *
 * Checks:
 * 1. link_hash matches canonical re-serialization of the link.
 * 2. link_signature verifies under link_algorithm (if not "none").
 * 3. approval_artifact.artifact_hash matches the locally-available artifact (if provided).
 * 4. If client is provided: re-calls /v1-verify-permit and updates
 *    verified_at_link_creation and last_verified_at on the returned copy.
 *
 * Returns a new ClaimEvidenceLink with an updated checklist and revision.
 * Does not mutate the input.
 */
export async function verifyClaimEvidenceLink(
  link: ClaimEvidenceLink,
  opts?: {
    client?: AtlaSentClient;
    signingSecret?: string | CryptoKey;
    skipPermitRecheck?: boolean;
  },
): Promise<{ link: ClaimEvidenceLink; valid: boolean; failedSlots: string[] }>;
```

### Python — `atlasent/governance/claim_lineage.py`

```python
from __future__ import annotations
from dataclasses import dataclass
from typing import Literal, Union

@dataclass(frozen=True)
class ClaimEvidenceLink:
    version: Literal["claim_evidence_link.v1"]
    link_id: str
    claim_id: str
    org_id: str
    linked_at: str
    updated_at: str
    revision: int
    link_algorithm: Literal["hmac-sha256", "ed25519", "none"]
    link_hash: str
    link_signature: str | None
    runtime_evidence: RuntimeEvidenceSlot
    deploy_evidence: DeployEvidenceSlot | None
    integration_evidence: IntegrationEvidenceSlot | None
    approval_artifact: ApprovalArtifactSlot | None
    delta: DeltaSlot
    verification_checklist: VerificationChecklist

async def build_claim_evidence_link(
    claim_id: str,
    *,
    runtime_evidence: DecisionReceipt,
    deploy_evidence: DeployGateResult | None = None,
    deploy_evidence_applicable: bool = True,
    integration_evidence: ComplianceEvidenceRun | None = None,
    integration_evidence_applicable: bool = True,
    approval_artifact: HitlChain | ApprovalArtifact | None = None,
    approval_artifact_applicable: bool = True,
    signing_secret: str | bytes | None = None,
) -> ClaimEvidenceLink: ...

async def verify_claim_evidence_link(
    link: ClaimEvidenceLink,
    *,
    client: AtlaSentClient | None = None,
    signing_secret: str | bytes | None = None,
    skip_permit_recheck: bool = False,
) -> tuple[ClaimEvidenceLink, bool, list[str]]:
    """Returns (updated_link, all_pass, failed_slots)."""
    ...
```

---

## Test vector requirements

Under `contract/vectors/claim-evidence-link/` once the schema lands:

| File | Scenario | `all_pass` |
|---|---|---|
| `valid-all-slots.json` | All 6 slots populated, delta computed, no drift | `true` |
| `valid-no-deploy.json` | `deploy_evidence: null`, `deploy_evidence_status: "not_applicable"` | `true` |
| `valid-no-approval.json` | `approval_artifact: null`, status `"not_applicable"` | `true` |
| `valid-delta-pending.json` | `delta.status: "pending"`, policy fields null | `false` (delta_computed=false) |
| `drift-policy-critical.json` | `policy_drift_detected: true`, `change_type: "rule_removed"`, `severity: "critical"` | `false` |
| `drift-schema-warning.json` | `schema_drift_detected: true`, SDK version mismatch | `false` |
| `permit-revoked.json` | `permit_revoked_at` non-null, `verified_at_link_creation: false` | `false` |
| `missing-slot.json` | `deploy_evidence_status: "missing"` (expected but not supplied) | `false` |
| `revision-2.json` | `revision: 2`, `updated_at` differs from `linked_at` | `true` |
| `INVALID-missing-runtime.json` | `runtime_evidence` field absent | schema validation error |
| `INVALID-bad-link-hash.json` | `link_hash` does not match canonical content | schema validates (hash format ok); integrity check fails |
| `INVALID-wrong-change-type.json` | `drift_details[0].change_type: "custom_string"` | schema validation error |

`INVALID-*` fixtures must fail JSON Schema validation.
All others must pass schema validation.
`contract/tools/validate_vectors.py` will be extended to load
and validate all `claim-evidence-link/` fixtures.

---

## Not in scope for v1

- `/v1/claim-evidence-links` server CRUD endpoints (v2)
- `?expand=` for embedded full artifacts (v2 API)
- Server-side delta computation endpoint (v2)
- Python OpenAPI codegen for `ClaimEvidenceLinkWire` (tracks `@atlasent/types` proposal 003)
- Non-TypeScript / non-Python SDK implementations
