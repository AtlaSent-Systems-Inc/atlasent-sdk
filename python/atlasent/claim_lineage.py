"""Claims → Evidence Lineage.

Mirrors ``typescript/src/claimLineage.ts``.

Builds and verifies :class:`ClaimEvidenceLink` objects — signed, wire-stable
artifacts that tie a canonical claim row to its full evidence chain:

1. **``runtime_evidence``** — :class:`RuntimeEvidenceInput` from ``protect_with_evidence()``
2. **``deploy_evidence``** — deploy gate record
3. **``integration_evidence``** — compliance run summary
4. **``approval_artifact``** — HITL chain or pre-signed approval artifact
5. **``delta``** — policy + schema drift since the claim was asserted
6. **``verification_checklist``** — machine-auditable ``all_pass`` + per-slot status

Wire schema: ``contract/schemas/claim-evidence-link.schema.json``
Proposal: ``contract/PROPOSALS/004-claims-evidence-links.md``

Quick start::

    from atlasent import build_claim_evidence_link, NOT_APPLICABLE

    link = build_claim_evidence_link(
        claim_id="claim_01j8abc",
        runtime_evidence=receipt,
        deploy_evidence=NOT_APPLICABLE,
        signing_secret=os.environ["ATLASENT_SIGNING_SECRET"],
    )
"""

from __future__ import annotations

import base64
import hashlib
import hmac as _hmac_module
import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Literal, TypedDict

from .exceptions import AtlaSentError

# SDK version recorded in delta.schema_version_*
_SDK_VERSION = "atlasent@2.4.0"

# ── Evidence slot wire types ──────────────────────────────────────────────────


@dataclass(frozen=True)
class RuntimeEvidenceSlot:
    permit_token: str
    audit_hash: str
    decision: Literal["allow", "deny", "escalate"]
    decision_id: str
    evaluated_at: str
    algorithm: str
    signature: str | None
    permit_revoked_at: str | None
    verified_at_claim_time: bool
    verified_at_link_creation: bool


@dataclass(frozen=True)
class DeployEvidenceSlot:
    deploy_id: str
    environment: str
    sha: str
    actor_id: str
    deployed_at: str
    gate_permit_token: str


@dataclass(frozen=True)
class IntegrationEvidenceSlot:
    run_id: str
    framework: str
    period_start: str
    period_end: str
    status: str
    passing_control_count: int
    failing_control_count: int
    run_completed_at: str


@dataclass(frozen=True)
class ApprovalArtifactSlot:
    approval_id: str
    approval_kind: Literal["hitl_chain", "approval_artifact"]
    quorum_type: Literal["single_approver", "simple_majority", "two_thirds", "unanimous"]
    approver_count: int
    approver_ids: tuple[str, ...]
    approved_at: str
    artifact_hash: str


DriftChangeType = Literal[
    "rule_added",
    "rule_removed",
    "rule_modified",
    "threshold_changed",
    "policy_updated",
    "schema_field_added",
    "schema_field_removed",
    "schema_field_type_changed",
]

DriftSeverity = Literal["info", "warning", "critical"]


@dataclass(frozen=True)
class DriftDetail:
    change_type: DriftChangeType
    severity: DriftSeverity
    description: str
    rule_id: str | None = None
    changed_at: str | None = None


DeltaStatus = Literal["pending", "computing", "computed", "failed"]

EvidenceSlotStatus = Literal["present", "not_applicable", "missing"]


@dataclass(frozen=True)
class DeltaSlot:
    status: DeltaStatus
    schema_version_at_claim: str
    schema_version_current: str
    schema_drift_detected: bool
    drift_details: tuple[DriftDetail, ...]
    computed_at: str | None = None
    policy_version_at_claim: str | None = None
    policy_version_current: str | None = None
    policy_drift_detected: bool | None = None


@dataclass(frozen=True)
class VerificationChecklist:
    runtime_evidence_present: bool
    verified_at_claim_time: bool
    verified_at_link_creation: bool
    deploy_evidence_status: EvidenceSlotStatus
    integration_evidence_status: EvidenceSlotStatus
    approval_artifact_status: EvidenceSlotStatus
    delta_computed: bool
    policy_drift_clean: bool | None
    schema_drift_clean: bool
    all_pass: bool
    computed_at: str
    last_verified_at: str | None = None


@dataclass(frozen=True)
class ClaimEvidenceLink:
    version: Literal["claim_evidence_link.v1"]
    link_id: str
    claim_id: str
    org_id: str
    linked_at: str
    updated_at: str
    revision: int
    link_algorithm: Literal["hmac-sha256", "none"]
    link_hash: str
    link_signature: str | None
    runtime_evidence: RuntimeEvidenceSlot
    deploy_evidence: DeployEvidenceSlot | None
    integration_evidence: IntegrationEvidenceSlot | None
    approval_artifact: ApprovalArtifactSlot | None
    delta: DeltaSlot
    verification_checklist: VerificationChecklist


# ── NOT_APPLICABLE sentinel ───────────────────────────────────────────────────


@dataclass(frozen=True)
class NotApplicable:
    """Sentinel that signals an evidence slot does not apply to this claim.

    Pass :data:`NOT_APPLICABLE` instead of ``None`` to explicitly mark a
    slot as not applicable. ``None`` means "expected but unavailable"
    (slot status ``"missing"``); :data:`NOT_APPLICABLE` means "not relevant
    for this action" (slot status ``"not_applicable"``).
    """

    not_applicable: bool = True


NOT_APPLICABLE = NotApplicable()


# ── Input TypedDicts ──────────────────────────────────────────────────────────


class RuntimeEvidenceInput(TypedDict, total=False):
    """Fields consumed from a DecisionReceipt to build RuntimeEvidenceSlot."""

    permit_id: str | None
    receipt_id: str
    audit_hash: str
    decision: str
    evaluation_id: str
    issued_at: str
    algorithm: str
    signature: str | None
    org_id: str | None


class DeployEvidenceInput(TypedDict):
    deploy_id: str
    environment: str
    sha: str
    actor_id: str
    deployed_at: str
    gate_permit_token: str


class IntegrationEvidenceInput(TypedDict, total=False):
    """Fields consumed from a ComplianceEvidenceRun to build IntegrationEvidenceSlot."""

    id: str
    framework: str
    period_start: str
    period_end: str
    status: str
    controls: list[object]
    created_at: str


class HitlChainSummaryInput(TypedDict):
    escalation: dict[str, object]
    approvals: list[dict[str, object]]
    artifact_hash: str


class SignedApprovalArtifactInput(TypedDict):
    approval_id: str
    approval_kind: Literal["approval_artifact"]
    quorum_type: str
    approver_ids: list[str]
    approved_at: str
    artifact_hash: str


@dataclass(frozen=True)
class VerifyClaimEvidenceLinkResult:
    """Result of :func:`verify_claim_evidence_link`."""

    link: ClaimEvidenceLink
    valid: bool
    failed_slots: tuple[str, ...]


# ── Internal helpers ──────────────────────────────────────────────────────────


def _canonical_json(obj: object) -> str:
    """Deterministic JSON with sorted keys and no whitespace.

    Equivalent to the TypeScript ``canonicalize()`` helper for the value
    types present in :class:`ClaimEvidenceLink`.
    """
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _hmac_sha256_base64url(payload: str, secret: str) -> str:
    digest = _hmac_module.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _link_body_dict(link: ClaimEvidenceLink) -> dict[str, object]:
    """Return the link as a plain dict without ``link_hash`` / ``link_signature``."""
    d = asdict(link)
    d.pop("link_hash")
    d.pop("link_signature")
    return d


def _compute_link_hash(body: dict[str, object]) -> str:
    return _sha256_hex(_canonical_json(body))


def _is_not_applicable(v: object) -> bool:
    return isinstance(v, NotApplicable)


def _slot_status(
    input_value: object,
    slot: DeployEvidenceSlot | IntegrationEvidenceSlot | ApprovalArtifactSlot | None,
) -> EvidenceSlotStatus:
    if _is_not_applicable(input_value):
        return "not_applicable"
    if slot is not None:
        return "present"
    return "missing"


def _to_deploy_slot(
    inp: DeployEvidenceInput | NotApplicable | None,
) -> DeployEvidenceSlot | None:
    if inp is None or _is_not_applicable(inp):
        return None
    d = inp  # type: ignore[assignment]
    return DeployEvidenceSlot(
        deploy_id=d["deploy_id"],
        environment=d["environment"],
        sha=d["sha"],
        actor_id=d["actor_id"],
        deployed_at=d["deployed_at"],
        gate_permit_token=d["gate_permit_token"],
    )


def _to_integration_slot(
    inp: IntegrationEvidenceInput | NotApplicable | None,
) -> IntegrationEvidenceSlot | None:
    if inp is None or _is_not_applicable(inp):
        return None
    d = inp  # type: ignore[assignment]
    controls = d.get("controls") or []
    passing = sum(1 for c in controls if (c.get("status") if isinstance(c, dict) else getattr(c, "status", None)) == "pass")  # type: ignore[union-attr]
    failing = len(controls) - passing
    return IntegrationEvidenceSlot(
        run_id=d["id"],
        framework=d.get("framework", "soc2"),
        period_start=d.get("period_start", ""),
        period_end=d.get("period_end", ""),
        status=d.get("status", "completed"),
        passing_control_count=passing,
        failing_control_count=failing,
        run_completed_at=d.get("created_at", ""),
    )


def _hitl_quorum_to_slot_quorum(tier: str) -> ApprovalArtifactSlot.__annotations__["quorum_type"]:  # type: ignore[type-arg]
    if tier in ("single_approver", "two_thirds", "unanimous"):
        return tier  # type: ignore[return-value]
    return "simple_majority"


def _to_approval_slot(
    inp: HitlChainSummaryInput | SignedApprovalArtifactInput | NotApplicable | None,
) -> ApprovalArtifactSlot | None:
    if inp is None or _is_not_applicable(inp):
        return None
    d = inp  # type: ignore[assignment]
    if "escalation" in d:
        chain = d  # type: ignore[assignment]
        approvals = chain["approvals"]
        approved = [a for a in approvals if a.get("decision") == "approve"]
        timestamps = sorted(a["created_at"] for a in approved if "created_at" in a)
        escalation = chain["escalation"]
        last_approved = timestamps[-1] if timestamps else escalation.get("created_at", "")
        return ApprovalArtifactSlot(
            approval_id=escalation.get("id", ""),
            approval_kind="hitl_chain",
            quorum_type=_hitl_quorum_to_slot_quorum(escalation.get("quorum_required", "")),
            approver_count=len(approved),
            approver_ids=tuple(a.get("user_id") or a.get("actor_label") or "unknown" for a in approved),
            approved_at=last_approved,
            artifact_hash=chain["artifact_hash"],
        )
    artifact = d  # type: ignore[assignment]
    return ApprovalArtifactSlot(
        approval_id=artifact["approval_id"],
        approval_kind="approval_artifact",
        quorum_type=_hitl_quorum_to_slot_quorum(artifact.get("quorum_type", "")),
        approver_count=len(artifact["approver_ids"]),
        approver_ids=tuple(artifact["approver_ids"]),
        approved_at=artifact["approved_at"],
        artifact_hash=artifact["artifact_hash"],
    )


def _to_runtime_slot(
    receipt: RuntimeEvidenceInput,
    verified_at_creation: bool,
) -> RuntimeEvidenceSlot:
    permit_token = receipt.get("permit_id") or receipt.get("receipt_id", "")
    decision_raw = receipt.get("decision", "deny")
    decision: Literal["allow", "deny", "escalate"] = (
        "allow" if decision_raw == "allow"
        else "escalate" if decision_raw == "escalate"
        else "deny"
    )
    return RuntimeEvidenceSlot(
        permit_token=permit_token,
        audit_hash=receipt.get("audit_hash", ""),
        decision=decision,
        decision_id=receipt.get("evaluation_id", ""),
        evaluated_at=receipt.get("issued_at", ""),
        algorithm=receipt.get("algorithm", "hmac-sha256"),
        signature=receipt.get("signature"),
        permit_revoked_at=None,
        verified_at_claim_time=decision_raw == "allow",
        verified_at_link_creation=verified_at_creation,
    )


def _build_checklist(
    runtime: RuntimeEvidenceSlot,
    deploy_status: EvidenceSlotStatus,
    integration_status: EvidenceSlotStatus,
    approval_status: EvidenceSlotStatus,
    delta: DeltaSlot,
    last_verified_at: str | None,
    now: str,
) -> VerificationChecklist:
    delta_computed = delta.status == "computed"
    policy_drift_clean: bool | None = (not delta.policy_drift_detected) if delta_computed else None
    schema_drift_clean = not delta.schema_drift_detected

    all_pass = (
        runtime.verified_at_claim_time
        and runtime.verified_at_link_creation
        and delta_computed
        and policy_drift_clean is True
        and schema_drift_clean
        and deploy_status != "missing"
        and integration_status != "missing"
        and approval_status != "missing"
    )

    return VerificationChecklist(
        runtime_evidence_present=True,
        verified_at_claim_time=runtime.verified_at_claim_time,
        verified_at_link_creation=runtime.verified_at_link_creation,
        deploy_evidence_status=deploy_status,
        integration_evidence_status=integration_status,
        approval_artifact_status=approval_status,
        delta_computed=delta_computed,
        policy_drift_clean=policy_drift_clean,
        schema_drift_clean=schema_drift_clean,
        all_pass=all_pass,
        last_verified_at=last_verified_at,
        computed_at=now,
    )


# ── Public API ────────────────────────────────────────────────────────────────


def build_claim_evidence_link(
    *,
    claim_id: str,
    runtime_evidence: RuntimeEvidenceInput,
    org_id: str | None = None,
    deploy_evidence: DeployEvidenceInput | NotApplicable | None = None,
    integration_evidence: IntegrationEvidenceInput | NotApplicable | None = None,
    approval_artifact: HitlChainSummaryInput | SignedApprovalArtifactInput | NotApplicable | None = None,
    signing_secret: str | None = None,
    schema_version: str | None = None,
) -> ClaimEvidenceLink:
    """Assemble a :class:`ClaimEvidenceLink` from SDK artifacts.

    - Generates a client-side ``link_id`` (``cel_`` + UUID v4 hex).
    - Schema drift is computed from the SDK version; policy drift starts
      as ``"pending"`` (server-side async).
    - Signs with HMAC-SHA256 when ``signing_secret`` is provided.
    - ``verified_at_link_creation`` is ``True`` when the receipt carries
      ``decision == "allow"`` (the permit was fresh at build time).

    The returned link has ``revision: 1``. Subsequent calls to
    :func:`verify_claim_evidence_link` increment ``revision`` and
    recompute ``link_hash`` / ``link_signature``.

    Args:
        claim_id: The canonical claim ID this link annotates.
        runtime_evidence: DecisionReceipt fields from ``protect_with_evidence()``.
        org_id: Owning org. Defaults to ``runtime_evidence["org_id"]``.
        deploy_evidence: Deploy gate record. Pass :data:`NOT_APPLICABLE` for
            non-deployment actions. ``None`` means expected-but-unavailable
            (slot status ``"missing"``).
        integration_evidence: Most recent compliance run. Pass
            :data:`NOT_APPLICABLE` when not relevant.
        approval_artifact: HITL chain summary or pre-signed artifact. Pass
            :data:`NOT_APPLICABLE` when no human approval was required.
        signing_secret: HMAC-SHA256 signing secret. When provided the link
            is signed and ``link_algorithm`` is ``"hmac-sha256"``.
        schema_version: Override SDK version in ``delta.schema_version_*``.
    """
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    link_id = "cel_" + uuid.uuid4().hex
    resolved_org_id: str = org_id or runtime_evidence.get("org_id") or ""
    sv = schema_version or _SDK_VERSION

    deploy_slot = _to_deploy_slot(deploy_evidence)
    integration_slot = _to_integration_slot(integration_evidence)
    approval_slot = _to_approval_slot(approval_artifact)

    deploy_status = _slot_status(deploy_evidence, deploy_slot)
    integration_status = _slot_status(integration_evidence, integration_slot)
    approval_status = _slot_status(approval_artifact, approval_slot)

    verified_at_creation = runtime_evidence.get("decision") == "allow"
    runtime = _to_runtime_slot(runtime_evidence, verified_at_creation)

    delta = DeltaSlot(
        status="pending",
        computed_at=None,
        policy_version_at_claim=None,
        policy_version_current=None,
        policy_drift_detected=None,
        schema_version_at_claim=sv,
        schema_version_current=sv,
        schema_drift_detected=False,
        drift_details=(),
    )

    last_verified_at = now if verified_at_creation else None
    checklist = _build_checklist(
        runtime, deploy_status, integration_status, approval_status, delta, last_verified_at, now,
    )

    link_algorithm: Literal["hmac-sha256", "none"] = "hmac-sha256" if signing_secret else "none"

    body: dict[str, object] = {
        "version": "claim_evidence_link.v1",
        "link_id": link_id,
        "claim_id": claim_id,
        "org_id": resolved_org_id,
        "linked_at": now,
        "updated_at": now,
        "revision": 1,
        "link_algorithm": link_algorithm,
        "runtime_evidence": asdict(runtime),
        "deploy_evidence": asdict(deploy_slot) if deploy_slot else None,
        "integration_evidence": asdict(integration_slot) if integration_slot else None,
        "approval_artifact": asdict(approval_slot) if approval_slot else None,
        "delta": asdict(delta),
        "verification_checklist": asdict(checklist),
    }

    link_hash = _compute_link_hash(body)
    link_signature = _hmac_sha256_base64url(link_hash, signing_secret) if signing_secret else None

    return ClaimEvidenceLink(
        version="claim_evidence_link.v1",
        link_id=link_id,
        claim_id=claim_id,
        org_id=resolved_org_id,
        linked_at=now,
        updated_at=now,
        revision=1,
        link_algorithm=link_algorithm,
        link_hash=link_hash,
        link_signature=link_signature,
        runtime_evidence=runtime,
        deploy_evidence=deploy_slot,
        integration_evidence=integration_slot,
        approval_artifact=approval_slot,
        delta=delta,
        verification_checklist=checklist,
    )


def verify_claim_evidence_link(
    link: ClaimEvidenceLink,
    *,
    signing_secret: str | None = None,
    skip_permit_recheck: bool = False,
) -> VerifyClaimEvidenceLinkResult:
    """Verify structural integrity and checklist freshness of a :class:`ClaimEvidenceLink`.

    Checks:

    1. ``link_hash`` matches a canonical re-serialisation of the link body.
    2. ``link_signature`` verifies under ``link_algorithm`` (when not ``"none"``).
    3. Recomputes the ``verification_checklist`` from the current slot state.

    Returns a new :class:`ClaimEvidenceLink` with:

    - Updated ``verified_at_link_creation`` / ``last_verified_at``.
    - Incremented ``revision``.
    - Recomputed ``link_hash`` / ``link_signature``.

    Does **not** mutate the input. Does **not** make network calls (permit
    re-verification via ``/v1-verify-permit`` is scoped for v2).

    Raises:
        AtlaSentError: with ``code="claim_evidence_incomplete"`` when
            ``all_pass`` is false or hash/signature verification fails.
    """
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    # 1. Verify link_hash
    body = _link_body_dict(link)
    expected_hash = _compute_link_hash(body)
    hash_valid = expected_hash == link.link_hash

    # 2. Verify signature
    sig_valid = True
    if link.link_algorithm == "hmac-sha256":
        if not signing_secret:
            sig_valid = False
        else:
            expected_sig = _hmac_sha256_base64url(link.link_hash, signing_secret)
            sig_valid = expected_sig == link.link_signature

    # 3. Recompute checklist
    runtime = RuntimeEvidenceSlot(
        permit_token=link.runtime_evidence.permit_token,
        audit_hash=link.runtime_evidence.audit_hash,
        decision=link.runtime_evidence.decision,
        decision_id=link.runtime_evidence.decision_id,
        evaluated_at=link.runtime_evidence.evaluated_at,
        algorithm=link.runtime_evidence.algorithm,
        signature=link.runtime_evidence.signature,
        permit_revoked_at=link.runtime_evidence.permit_revoked_at,
        verified_at_claim_time=link.runtime_evidence.verified_at_claim_time,
        verified_at_link_creation=hash_valid and sig_valid and link.runtime_evidence.verified_at_link_creation,
    )

    checklist = _build_checklist(
        runtime,
        link.verification_checklist.deploy_evidence_status,
        link.verification_checklist.integration_evidence_status,
        link.verification_checklist.approval_artifact_status,
        link.delta,
        (link.verification_checklist.last_verified_at or now) if runtime.verified_at_link_creation else None,
        now,
    )

    # 4. Build updated link
    updated_body: dict[str, object] = {
        "version": link.version,
        "link_id": link.link_id,
        "claim_id": link.claim_id,
        "org_id": link.org_id,
        "linked_at": link.linked_at,
        "updated_at": now,
        "revision": link.revision + 1,
        "link_algorithm": link.link_algorithm,
        "runtime_evidence": asdict(runtime),
        "deploy_evidence": asdict(link.deploy_evidence) if link.deploy_evidence else None,
        "integration_evidence": asdict(link.integration_evidence) if link.integration_evidence else None,
        "approval_artifact": asdict(link.approval_artifact) if link.approval_artifact else None,
        "delta": asdict(link.delta),
        "verification_checklist": asdict(checklist),
    }

    new_hash = _compute_link_hash(updated_body)
    if signing_secret:
        new_sig: str | None = _hmac_sha256_base64url(new_hash, signing_secret)
    elif link.link_algorithm == "none":
        new_sig = None
    else:
        new_sig = link.link_signature

    updated_link = ClaimEvidenceLink(
        version=link.version,
        link_id=link.link_id,
        claim_id=link.claim_id,
        org_id=link.org_id,
        linked_at=link.linked_at,
        updated_at=now,
        revision=link.revision + 1,
        link_algorithm=link.link_algorithm,
        link_hash=new_hash,
        link_signature=new_sig,
        runtime_evidence=runtime,
        deploy_evidence=link.deploy_evidence,
        integration_evidence=link.integration_evidence,
        approval_artifact=link.approval_artifact,
        delta=link.delta,
        verification_checklist=checklist,
    )

    # 5. Collect failed slots
    failed: list[str] = []
    if not hash_valid:
        failed.append("link_hash")
    if not sig_valid:
        failed.append("link_signature")
    if not checklist.verified_at_claim_time:
        failed.append("verified_at_claim_time")
    if not checklist.verified_at_link_creation:
        failed.append("verified_at_link_creation")
    if not checklist.delta_computed:
        failed.append("delta_computed")
    if checklist.policy_drift_clean is False:
        failed.append("policy_drift_clean")
    if not checklist.schema_drift_clean:
        failed.append("schema_drift_clean")
    if checklist.deploy_evidence_status == "missing":
        failed.append("deploy_evidence_status")
    if checklist.integration_evidence_status == "missing":
        failed.append("integration_evidence_status")
    if checklist.approval_artifact_status == "missing":
        failed.append("approval_artifact_status")

    if failed:
        raise AtlaSentError(
            f"ClaimEvidenceLink verification failed: {', '.join(failed)}",
            code="claim_evidence_incomplete",
        )

    return VerifyClaimEvidenceLinkResult(
        link=updated_link,
        valid=True,
        failed_slots=(),
    )


# ── Action bundle helper ──────────────────────────────────────────────────────


class ActionBundleReceipt(TypedDict, total=False):
    """Subset of EvidenceReceipt fields from atlasent-action's ActionEvidenceBundle."""

    receipt_id: str
    evaluation_id: str
    permit_id: str | None
    audit_hash: str | None
    issued_at: str
    algorithm: str
    signature: str | None
    decision: str


class ActionBundleInput(TypedDict, total=False):
    """Minimal ActionEvidenceBundle fields consumed by build_claim_evidence_link_from_action_bundle."""

    bundle_id: str
    action: str
    actor: str
    environment: str
    repository: str
    sha: str
    run_id: str
    generated_at: str
    receipt: ActionBundleReceipt


def build_claim_evidence_link_from_action_bundle(
    bundle: ActionBundleInput,
    *,
    claim_id: str,
    org_id: str | None = None,
    deploy_not_applicable: bool = False,
    signing_secret: str | None = None,
    schema_version: str | None = None,
) -> ClaimEvidenceLink:
    """Build a :class:`ClaimEvidenceLink` from an ``ActionEvidenceBundle`` JSON blob.

    The GitHub Action emits an ``ActionEvidenceBundle`` as a job output and
    artifact after a successful ``enforce()``. This helper maps that bundle
    to a ``ClaimEvidenceLink`` in one call, so Action users don't need to
    construct the receipt manually.

    The action bundle's ``receipt`` becomes ``runtime_evidence``. The bundle's
    deploy context (``sha``, ``environment``, ``actor``, ``bundle_id``) is
    auto-populated as ``deploy_evidence`` unless *deploy_not_applicable* is
    ``True``.

    Args:
        bundle: Parsed ``ActionEvidenceBundle`` JSON from the action output.
        claim_id: The canonical claim row ID this link is attached to.
        org_id: Organisation ID. Defaults to ``""`` when omitted.
        deploy_not_applicable: Pass ``True`` to mark the deploy slot as N/A
            (e.g., for non-deployment actions).
        signing_secret: HMAC-SHA256 key for :attr:`ClaimEvidenceLink.link_signature`.
        schema_version: Override the ``delta.schema_version_at_claim_time`` field.
    """
    receipt: ActionBundleReceipt = bundle.get("receipt", {})  # type: ignore[assignment]
    receipt_id: str = receipt.get("receipt_id", "")
    permit_id: str | None = receipt.get("permit_id")

    runtime_input: RuntimeEvidenceInput = {
        "receipt_id": receipt_id,
        "evaluation_id": receipt.get("evaluation_id", ""),
        "permit_id": permit_id,
        "audit_hash": receipt.get("audit_hash") or "",
        "issued_at": receipt.get("issued_at", ""),
        "decision": receipt.get("decision", "deny"),
        "algorithm": receipt.get("algorithm", "none"),
        "signature": receipt.get("signature"),
        "org_id": org_id or "",
    }

    deploy_input: DeployEvidenceInput | NotApplicable
    if deploy_not_applicable:
        deploy_input = NOT_APPLICABLE
    else:
        deploy_input = DeployEvidenceInput(
            deploy_id=bundle.get("bundle_id", ""),
            environment=bundle.get("environment", ""),
            sha=bundle.get("sha", ""),
            actor_id=bundle.get("actor", ""),
            deployed_at=bundle.get("generated_at", ""),
            gate_permit_token=permit_id if permit_id else receipt_id,
        )

    kwargs: dict[str, object] = {
        "claim_id": claim_id,
        "runtime_evidence": runtime_input,
        "deploy_evidence": deploy_input,
    }
    if org_id is not None:
        kwargs["org_id"] = org_id
    if signing_secret is not None:
        kwargs["signing_secret"] = signing_secret
    if schema_version is not None:
        kwargs["schema_version"] = schema_version

    return build_claim_evidence_link(**kwargs)  # type: ignore[arg-type]
