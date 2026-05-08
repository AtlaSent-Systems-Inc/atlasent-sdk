"""Tests for atlasent.governance.economic_evidence.

Focus on: signable content shape, content_hash determinism, structural
verification, byte-equivalence with the canonical TS implementation.
"""

from __future__ import annotations

from atlasent.governance import (
    ApprovalProvenance,
    BudgetConstraintCheckResult,
    EconomicEvidenceBundle,
    FinancialExecutionRecord,
    FinancialQuorumResult,
    LiabilityAttributionRecord,
    build_signable_content,
    canonicalize_for_evidence,
    compute_content_hash,
    serialize_signable_content,
    verify_evidence_bundle_structure,
)


def _make_execution() -> FinancialExecutionRecord:
    return FinancialExecutionRecord(
        execution_id="exec_001",
        action_class_id="wire_transfer.domestic",
        org_id="org_xyz",
        action_value=125_000.0,
        currency="USD",
        risk_tier="high",
        liability_classification="shared",
        initiator_id="u_alice",
        executor_id="u_bob",
        approver_ids=("u_charlie", "u_diana"),
        permit_ids=("perm_a1", "perm_b2", "perm_c3"),
        override_applied=False,
        override_id=None,
        status="completed",
        authorized_at="2026-05-08T12:00:00Z",
        executed_at="2026-05-08T12:00:05Z",
        audit_hash="a" * 64,
        context={},
    )


def _make_attribution() -> LiabilityAttributionRecord:
    return LiabilityAttributionRecord(
        attribution_id="attr_001",
        execution_id="exec_001",
        org_id="org_xyz",
        classification="shared",
        risk_tier="high",
        liability_chain=(),
        delegation_present=False,
        supervisory_present=False,
        emergency_override=False,
        override_justification=None,
        chain_hash="deadbeef" * 8,
        created_at="2026-05-08T12:00:00Z",
    )


def _make_provenance() -> tuple[ApprovalProvenance, ...]:
    return (
        ApprovalProvenance(
            approver_id="u_charlie",
            approver_label="Charlie",
            permit_id="perm_a1",
            approved_at="2026-05-08T11:55:00Z",
            audit_hash="b" * 64,
            role="finance_lead",
        ),
        ApprovalProvenance(
            approver_id="u_diana",
            approver_label="Diana",
            permit_id="perm_b2",
            approved_at="2026-05-08T11:58:00Z",
            audit_hash="c" * 64,
            role="cfo",
        ),
    )


def test_build_signable_content_pulls_canonical_fields() -> None:
    content = build_signable_content(
        bundle_id="egb_abc",
        org_id="org_xyz",
        purpose="regulator_review",
        execution_record=_make_execution(),
        liability_attribution=_make_attribution(),
        approval_provenance=_make_provenance(),
        policy_compliant=True,
        generated_at="2026-05-08T13:00:00Z",
    )
    assert content.bundle_id == "egb_abc"
    assert content.execution_id == "exec_001"
    assert content.attribution_id == "attr_001"
    assert content.liability_chain_hash == "deadbeef" * 8
    assert content.approval_count == 2
    assert tuple(content.permit_ids) == ("perm_a1", "perm_b2")


def test_compute_content_hash_is_deterministic() -> None:
    content = build_signable_content(
        bundle_id="egb_abc",
        org_id="org_xyz",
        purpose="regulator_review",
        execution_record=_make_execution(),
        liability_attribution=_make_attribution(),
        approval_provenance=_make_provenance(),
        policy_compliant=True,
        generated_at="2026-05-08T13:00:00Z",
    )
    h1 = compute_content_hash(content)
    h2 = compute_content_hash(content)
    assert h1 == h2
    assert len(h1) == 64


def test_signable_bytes_use_canonical_encoder() -> None:
    content = build_signable_content(
        bundle_id="egb_abc",
        org_id="org_xyz",
        purpose="regulator_review",
        execution_record=_make_execution(),
        liability_attribution=_make_attribution(),
        approval_provenance=_make_provenance(),
        policy_compliant=True,
        generated_at="2026-05-08T13:00:00Z",
    )
    bytes_out = serialize_signable_content(content)
    expected = canonicalize_for_evidence(content.to_dict()).encode("utf-8")
    assert bytes_out == expected


def _make_bundle_passing_verification(
    *, content_hash: str = "d" * 64, signature: str | None = None
) -> EconomicEvidenceBundle:
    return EconomicEvidenceBundle(
        bundle_id="egb_abc",
        org_id="org_xyz",
        purpose="regulator_review",
        execution_record=_make_execution(),
        liability_attribution=_make_attribution(),
        quorum_result=FinancialQuorumResult(
            passed=True,
            base_quorum_passed=True,
            amount_threshold_satisfied=True,
            financial_roles_satisfied=True,
            regulator_approval_missing=False,
            blocked_by_freeze=False,
            base_quorum_proof=None,
            denial_reason=None,
            unmet_requirements=(),
        ),
        budget_check=BudgetConstraintCheckResult(
            permitted=True,
            hard_blocks=(),
            soft_warnings=(),
            limits_checked=(),
            constraints_checked=(),
        ),
        approval_provenance=_make_provenance(),
        runtime_conformity=True,
        runtime_conformity_notes=(),
        policy_compliant=True,
        policy_violations=(),
        generated_at="2026-05-08T13:00:00Z",
        requested_by="u_admin",
        content_hash=content_hash,
        signature=signature,
        signing_key_id="key_001" if signature else None,
    )


def test_verify_structure_happy_path() -> None:
    bundle = _make_bundle_passing_verification(signature="sig_base64url")
    result = verify_evidence_bundle_structure(bundle)
    assert result.valid is True
    assert result.content_hash_valid is True
    assert result.permit_ids_match is True
    assert result.liability_chain_hash_matches is True
    assert result.signature_valid is True


def test_verify_structure_rejects_short_content_hash() -> None:
    bundle = _make_bundle_passing_verification(content_hash="deadbeef")
    result = verify_evidence_bundle_structure(bundle)
    assert result.valid is False
    assert result.content_hash_valid is False
    assert result.reason is not None


def test_verify_structure_signature_optional() -> None:
    # Bundle without signature is still structurally valid (signing is
    # an out-of-band concern); signature_valid should report False.
    bundle = _make_bundle_passing_verification(signature=None)
    result = verify_evidence_bundle_structure(bundle)
    assert result.valid is True
    assert result.signature_valid is False
