"""evidence_engine — per-decision proof types and "why" traces.

Python mirror of the TypeScript ``evidenceEngine.ts`` module. Provides
structured types for compliance-ready artifacts that callers can hand
to auditors, compliance teams, and regulators.

Primary types:

- :class:`WhyTrace` — structured "why allowed / why denied" trace
- :class:`DecisionReceipt` — signed per-decision proof artifact
- :class:`ActionEvidenceBundle` — full compliance-ready bundle
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

# ── Why Trace ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class WhyStage:
    """One evaluated stage within a policy, in evaluation order."""

    stage: str
    """Engine stage name (e.g. ``"role_check"``, ``"context"``)."""

    matched: bool
    """Whether this stage's predicate fired / matched."""

    impact: Literal["terminal", "contributing", "passing"]
    """Impact classification:

    - ``"terminal"`` — this stage caused the outer decision.
    - ``"contributing"`` — matched but was not the decisive stage.
    - ``"passing"`` — did not match; execution continued.
    """

    rule: str | None = None
    """Rule identifier, if the stage is rule-bound."""

    detail: str | None = None
    """Non-obvious detail from the engine."""


@dataclass(frozen=True)
class WhyPolicyEvaluation:
    """Per-policy evaluation block within a :class:`WhyTrace`."""

    policy_id: str
    decision: str
    """Policy-level decision."""

    fingerprint: str
    """Engine-side fingerprint of the policy bundle row."""

    stages: tuple[WhyStage, ...]
    """Stages evaluated for this policy, in order."""

    was_decisive: bool
    """``True`` iff this policy's decision drove the outer envelope decision."""

    risk_score: float | None = None
    """Optional risk score from a ``risk`` rule clause."""


@dataclass(frozen=True)
class WhyTrace:
    """Structured "why allowed / why denied" trace.

    Produced from the ``ConstraintTrace`` returned by
    ``/v1-evaluate?include=constraint_trace``. Suitable for:

    - UI display ("Why was this denied?")
    - Email / Slack notifications
    - Compliance-bundle human-readable section
    - Machine-readable policy audit by external verifiers

    ``summary`` is a one-sentence plain-English explanation.
    """

    decision: str
    """Canonical decision: ``"allow"``, ``"deny"``, ``"hold"``, or ``"escalate"``."""

    summary: str
    """One-sentence human-readable explanation."""

    policy_evaluations: tuple[WhyPolicyEvaluation, ...]
    """Per-policy evaluation blocks in evaluation order."""

    total_stages_evaluated: int
    """Total stages evaluated across all policies."""

    matched_policy_id: str | None = None
    """Policy whose decision drove the outer result. Absent on clean allow."""

    terminal_stage: WhyStage | None = None
    """The single stage that caused the terminal outcome. ``None`` on clean allow."""


# ── Decision Receipt ──────────────────────────────────────────────────────────

DecisionReceiptAlgorithm = Literal["hmac-sha256", "ed25519", "none"]


@dataclass(frozen=True)
class DecisionReceiptPayload:
    """The canonical signed payload of a :class:`DecisionReceipt`.

    Field order is load-bearing: HMAC and chain verifiers stringify
    this object in a deterministic order. Do not reorder fields.
    """

    evaluation_id: str
    org_id: str
    action: str
    actor: str
    decision: str
    """Canonical decision value."""

    policy_fingerprint: str
    """Hash of the policy bundle evaluated."""

    reasons: tuple[str, ...]
    """Policy-provided denial or allow reasons."""

    issued_at: str
    """ISO-8601 timestamp when the receipt was created."""

    risk_score: float | None = None
    """Optional weighted risk score from the risk envelope."""

    override_id: str | None = None
    """Override ID when an active override influenced the decision."""


@dataclass(frozen=True)
class DecisionReceipt:
    """A self-contained, signed proof that a specific action was (or was not)
    authorized at a specific moment.

    Every enforcement adapter produces one; every compliance bundle includes
    one. Offline verifiable via ``verify_receipt_hmac()``.
    """

    alg: DecisionReceiptAlgorithm
    payload: DecisionReceiptPayload
    sig: str
    """Base64url-encoded signature over the canonical payload string."""

    issued_at: str
    """ISO-8601 issuance timestamp (mirrors ``payload.issued_at``)."""

    signer_id: str | None = None
    """Opaque identifier for the signing key or service."""


# ── Compliance Coverage ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class ComplianceControlCoverage:
    """Coverage summary for one compliance control within a bundle."""

    framework: str
    """Compliance framework identifier (e.g. ``"soc2"``, ``"iso27001"``)."""

    control_id: str
    title: str
    covered: bool
    """``True`` when this bundle provides sufficient evidence for the control."""

    evidence_kinds: tuple[str, ...]
    """Evidence kinds present in the bundle that map to this control."""


# ── Action Evidence Bundle ────────────────────────────────────────────────────


@dataclass(frozen=True)
class ActionEvidenceBundle:
    """A compliance-ready evidence bundle for a single protected action.

    Contains everything an auditor needs to verify the authorization
    decision without querying the API:

    - The signed :class:`DecisionReceipt`
    - The "why" trace (why allowed / why denied)
    - Audit events from the decision window
    - Permit chain (when the decision was ``"allow"``)
    - Active overrides that influenced the decision
    - Per-control SOC 2 / compliance coverage map

    ``bundle_hash`` is SHA-256 of the canonical JSON of this bundle
    (with ``bundle_hash`` omitted).
    """

    v: Literal[1]
    """Wire format version."""

    bundle_id: str
    evaluation_id: str
    org_id: str
    action: str
    actor: str
    decision: str
    """Canonical decision: ``"allow"``, ``"deny"``, ``"hold"``, ``"escalate"``."""

    receipt: DecisionReceipt
    why_trace: WhyTrace | None
    audit_events: tuple[dict[str, Any], ...]
    permit_chain: tuple[dict[str, Any], ...]
    overrides: tuple[dict[str, Any], ...]
    compliance_controls: tuple[ComplianceControlCoverage, ...]
    generated_at: str
    bundle_hash: str
    """SHA-256 hex of canonical JSON of this bundle (sans this field)."""


__all__ = [
    "ActionEvidenceBundle",
    "ComplianceControlCoverage",
    "DecisionReceipt",
    "DecisionReceiptAlgorithm",
    "DecisionReceiptPayload",
    "WhyPolicyEvaluation",
    "WhyStage",
    "WhyTrace",
]
