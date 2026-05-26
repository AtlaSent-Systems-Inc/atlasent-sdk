"""Tests for atlasent.claim_lineage.

Mirrors typescript/test/claim-lineage.test.ts.
"""

from __future__ import annotations

from dataclasses import asdict

import pytest

from atlasent.claim_lineage import (
    NOT_APPLICABLE,
    ActionBundleInput,
    ActionBundleReceipt,
    ClaimEvidenceLink,
    DeltaSlot,
    DeployEvidenceInput,
    HitlChainSummaryInput,
    IntegrationEvidenceInput,
    NotApplicable,
    RuntimeEvidenceInput,
    SignedApprovalArtifactInput,
    VerificationChecklist,
    _canonical_json,
    _compute_link_hash,
    _hmac_sha256_base64url,
    _sha256_hex,
    build_claim_evidence_link,
    build_claim_evidence_link_from_action_bundle,
    verify_claim_evidence_link,
)
from atlasent.exceptions import AtlaSentError

# ---------------------------------------------------------------------------
# Helpers / Fixtures
# ---------------------------------------------------------------------------


def make_receipt(**overrides: object) -> RuntimeEvidenceInput:
    base: RuntimeEvidenceInput = {
        "permit_id": "tok_01j9aaa",
        "receipt_id": "rec_01j9aaa",
        "audit_hash": "a" * 64,
        "decision": "allow",
        "evaluation_id": "dec_01j8aaa",
        "issued_at": "2026-05-20T09:59:55Z",
        "algorithm": "hmac-sha256",
        "signature": "dGhpcyBpcyBhIHRlc3Q",
        "org_id": "org-acme",
    }
    base.update(overrides)  # type: ignore[typeddict-item]
    return base


def make_compliance_run(**overrides: object) -> IntegrationEvidenceInput:
    base: IntegrationEvidenceInput = {
        "id": "run_01j7pqr",
        "framework": "soc2",
        "period_start": "2026-04-01",
        "period_end": "2026-06-30",
        "status": "completed",
        "controls": [],
        "created_at": "2026-05-19T23:00:00Z",
    }
    base.update(overrides)  # type: ignore[typeddict-item]
    return base


def make_deploy_input(**overrides: object) -> DeployEvidenceInput:
    base: DeployEvidenceInput = {
        "deploy_id": "deploy_01j9aaa",
        "environment": "production",
        "sha": "a3f9bc1234567890abcdef",
        "actor_id": "user-ci-runner",
        "deployed_at": "2026-05-20T09:58:00Z",
        "gate_permit_token": "tok_deploy_01j9",
    }
    base.update(overrides)  # type: ignore[typeddict-item]
    return base


def make_hitl_summary(**overrides: object) -> HitlChainSummaryInput:
    base: HitlChainSummaryInput = {
        "escalation": {
            "id": "esc_01j9aaa",
            "quorum_required": "simple_majority",
            "created_at": "2026-05-20T09:55:00Z",
        },
        "approvals": [
            {
                "decision": "approve",
                "user_id": "user-cfo",
                "created_at": "2026-05-20T09:56:00Z",
            },
            {
                "decision": "approve",
                "user_id": "user-fm",
                "created_at": "2026-05-20T09:57:00Z",
            },
        ],
        "artifact_hash": "b" * 64,
    }
    base.update(overrides)  # type: ignore[typeddict-item]
    return base


def make_signed_artifact(**overrides: object) -> SignedApprovalArtifactInput:
    base: SignedApprovalArtifactInput = {
        "approval_id": "apr_01j8aaa",
        "approval_kind": "approval_artifact",
        "quorum_type": "simple_majority",
        "approver_ids": ["user-cfo", "user-fm"],
        "approved_at": "2026-05-20T09:55:00Z",
        "artifact_hash": "c" * 64,
    }
    base.update(overrides)  # type: ignore[typeddict-item]
    return base


# ---------------------------------------------------------------------------
# build_claim_evidence_link — top-level shape
# ---------------------------------------------------------------------------


def test_build_returns_claim_evidence_link():
    link = build_claim_evidence_link(
        claim_id="claim_01j8abc",
        runtime_evidence=make_receipt(),
    )
    assert isinstance(link, ClaimEvidenceLink)
    assert link.version == "claim_evidence_link.v1"
    assert link.revision == 1
    assert link.link_id.startswith("cel_")
    assert len(link.link_id) == 36  # cel_ + 32 hex chars


def test_build_link_id_unique():
    a = build_claim_evidence_link(claim_id="c1", runtime_evidence=make_receipt())
    b = build_claim_evidence_link(claim_id="c1", runtime_evidence=make_receipt())
    assert a.link_id != b.link_id


def test_build_org_id_from_receipt():
    link = build_claim_evidence_link(
        claim_id="claim_01",
        runtime_evidence=make_receipt(org_id="org-xyz"),
    )
    assert link.org_id == "org-xyz"


def test_build_org_id_override():
    link = build_claim_evidence_link(
        claim_id="claim_01",
        runtime_evidence=make_receipt(org_id="org-xyz"),
        org_id="org-override",
    )
    assert link.org_id == "org-override"


# ---------------------------------------------------------------------------
# runtime_evidence slot
# ---------------------------------------------------------------------------


def test_runtime_evidence_allow():
    link = build_claim_evidence_link(
        claim_id="c", runtime_evidence=make_receipt(decision="allow")
    )
    rt = link.runtime_evidence
    assert rt.verified_at_claim_time is True
    assert rt.verified_at_link_creation is True
    assert rt.decision == "allow"
    assert rt.permit_token == "tok_01j9aaa"


def test_runtime_evidence_deny():
    link = build_claim_evidence_link(
        claim_id="c", runtime_evidence=make_receipt(decision="deny")
    )
    rt = link.runtime_evidence
    assert rt.verified_at_claim_time is False
    assert rt.verified_at_link_creation is False
    assert rt.decision == "deny"


def test_runtime_evidence_permit_id_fallback():
    """Falls back to receipt_id when permit_id absent."""
    receipt = make_receipt()
    del receipt["permit_id"]  # type: ignore[misc]
    link = build_claim_evidence_link(claim_id="c", runtime_evidence=receipt)
    assert link.runtime_evidence.permit_token == "rec_01j9aaa"


# ---------------------------------------------------------------------------
# Evidence slot states
# ---------------------------------------------------------------------------


def test_all_slots_none_gives_missing():
    link = build_claim_evidence_link(claim_id="c", runtime_evidence=make_receipt())
    cl = link.verification_checklist
    assert cl.deploy_evidence_status == "missing"
    assert cl.integration_evidence_status == "missing"
    assert cl.approval_artifact_status == "missing"
    assert link.deploy_evidence is None
    assert link.integration_evidence is None
    assert link.approval_artifact is None


def test_not_applicable_sentinel():
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        deploy_evidence=NOT_APPLICABLE,
        integration_evidence=NOT_APPLICABLE,
        approval_artifact=NOT_APPLICABLE,
    )
    cl = link.verification_checklist
    assert cl.deploy_evidence_status == "not_applicable"
    assert cl.integration_evidence_status == "not_applicable"
    assert cl.approval_artifact_status == "not_applicable"
    assert link.deploy_evidence is None
    assert link.integration_evidence is None
    assert link.approval_artifact is None


def test_present_slots():
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        deploy_evidence=make_deploy_input(),
        integration_evidence=make_compliance_run(),
        approval_artifact=make_hitl_summary(),
    )
    cl = link.verification_checklist
    assert cl.deploy_evidence_status == "present"
    assert cl.integration_evidence_status == "present"
    assert cl.approval_artifact_status == "present"
    assert link.deploy_evidence is not None
    assert link.integration_evidence is not None
    assert link.approval_artifact is not None


# ---------------------------------------------------------------------------
# Deploy / integration / approval slot contents
# ---------------------------------------------------------------------------


def test_deploy_slot_fields():
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        deploy_evidence=make_deploy_input(),
    )
    d = link.deploy_evidence
    assert d is not None
    assert d.deploy_id == "deploy_01j9aaa"
    assert d.environment == "production"


def test_integration_slot_control_counts():
    controls = [
        {"control_id": "CC6.1", "status": "pass"},
        {"control_id": "CC7.2", "status": "pass"},
        {"control_id": "CC8.1", "status": "gap"},
    ]
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        integration_evidence=make_compliance_run(controls=controls),
    )
    s = link.integration_evidence
    assert s is not None
    assert s.passing_control_count == 2
    assert s.failing_control_count == 1


def test_hitl_chain_approval_slot():
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        approval_artifact=make_hitl_summary(),
    )
    a = link.approval_artifact
    assert a is not None
    assert a.approval_kind == "hitl_chain"
    assert a.approver_count == 2
    assert "user-cfo" in a.approver_ids


def test_signed_artifact_approval_slot():
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        approval_artifact=make_signed_artifact(),
    )
    a = link.approval_artifact
    assert a is not None
    assert a.approval_kind == "approval_artifact"
    assert a.approver_count == 2


# ---------------------------------------------------------------------------
# Delta slot
# ---------------------------------------------------------------------------


def test_delta_pending_at_creation():
    link = build_claim_evidence_link(claim_id="c", runtime_evidence=make_receipt())
    assert link.delta.status == "pending"
    assert link.delta.computed_at is None
    assert link.delta.policy_drift_detected is None
    assert link.delta.schema_drift_detected is False
    assert link.delta.drift_details == ()


def test_schema_version_default():
    link = build_claim_evidence_link(claim_id="c", runtime_evidence=make_receipt())
    assert "atlasent" in link.delta.schema_version_at_claim


def test_schema_version_override():
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        schema_version="atlasent@9.9.9",
    )
    assert link.delta.schema_version_at_claim == "atlasent@9.9.9"
    assert link.delta.schema_version_current == "atlasent@9.9.9"


# ---------------------------------------------------------------------------
# Hash and signature
# ---------------------------------------------------------------------------


def test_unsigned_link_has_none_signature():
    link = build_claim_evidence_link(claim_id="c", runtime_evidence=make_receipt())
    assert link.link_algorithm == "none"
    assert link.link_signature is None
    assert len(link.link_hash) == 64  # sha256 hex


def test_signed_link_has_hmac_signature():
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        signing_secret="s3cr3t",
    )
    assert link.link_algorithm == "hmac-sha256"
    assert link.link_signature is not None
    # Verify signature manually
    expected = _hmac_sha256_base64url(link.link_hash, "s3cr3t")
    assert link.link_signature == expected


def test_different_claim_id_produces_different_hash():
    a = build_claim_evidence_link(claim_id="claim_A", runtime_evidence=make_receipt())
    b = build_claim_evidence_link(claim_id="claim_B", runtime_evidence=make_receipt())
    assert a.link_hash != b.link_hash


# ---------------------------------------------------------------------------
# verification_checklist all_pass
# ---------------------------------------------------------------------------


def test_all_pass_false_when_delta_pending():
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        deploy_evidence=NOT_APPLICABLE,
        integration_evidence=NOT_APPLICABLE,
        approval_artifact=NOT_APPLICABLE,
    )
    # delta.status == "pending" → all_pass must be False
    assert link.verification_checklist.all_pass is False
    assert link.verification_checklist.delta_computed is False


def test_all_pass_false_when_slot_missing():
    link = build_claim_evidence_link(claim_id="c", runtime_evidence=make_receipt())
    assert link.verification_checklist.all_pass is False


def test_all_pass_false_when_deny():
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(decision="deny"),
        deploy_evidence=NOT_APPLICABLE,
        integration_evidence=NOT_APPLICABLE,
        approval_artifact=NOT_APPLICABLE,
    )
    assert link.verification_checklist.all_pass is False
    assert link.verification_checklist.verified_at_claim_time is False


def test_policy_drift_clean_null_when_pending():
    link = build_claim_evidence_link(claim_id="c", runtime_evidence=make_receipt())
    assert link.verification_checklist.policy_drift_clean is None


def test_last_verified_at_set_for_allow():
    link = build_claim_evidence_link(
        claim_id="c", runtime_evidence=make_receipt(decision="allow")
    )
    assert link.verification_checklist.last_verified_at is not None


def test_last_verified_at_none_for_deny():
    link = build_claim_evidence_link(
        claim_id="c", runtime_evidence=make_receipt(decision="deny")
    )
    assert link.verification_checklist.last_verified_at is None


# ---------------------------------------------------------------------------
# verify_claim_evidence_link — integrity checks
# ---------------------------------------------------------------------------


def test_verify_tampered_hash_raises():
    link = build_claim_evidence_link(claim_id="c", runtime_evidence=make_receipt())
    tampered = ClaimEvidenceLink(
        version=link.version,
        link_id=link.link_id,
        claim_id=link.claim_id,
        org_id=link.org_id,
        linked_at=link.linked_at,
        updated_at=link.updated_at,
        revision=link.revision,
        link_algorithm=link.link_algorithm,
        link_hash="00" * 32,  # wrong hash
        link_signature=link.link_signature,
        runtime_evidence=link.runtime_evidence,
        deploy_evidence=link.deploy_evidence,
        integration_evidence=link.integration_evidence,
        approval_artifact=link.approval_artifact,
        delta=link.delta,
        verification_checklist=link.verification_checklist,
    )
    with pytest.raises(AtlaSentError) as exc_info:
        verify_claim_evidence_link(tampered)
    assert exc_info.value.code == "claim_evidence_incomplete"
    assert "link_hash" in exc_info.value.message


def test_verify_wrong_secret_raises():
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        signing_secret="correct-secret",
    )
    with pytest.raises(AtlaSentError) as exc_info:
        verify_claim_evidence_link(link, signing_secret="wrong-secret")
    assert exc_info.value.code == "claim_evidence_incomplete"
    assert "link_signature" in exc_info.value.message


def test_verify_missing_secret_for_signed_link_raises():
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        signing_secret="s3cr3t",
    )
    with pytest.raises(AtlaSentError) as exc_info:
        verify_claim_evidence_link(link)  # no signing_secret
    assert exc_info.value.code == "claim_evidence_incomplete"


def test_verify_pending_delta_raises():
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        deploy_evidence=NOT_APPLICABLE,
        integration_evidence=NOT_APPLICABLE,
        approval_artifact=NOT_APPLICABLE,
    )
    with pytest.raises(AtlaSentError) as exc_info:
        verify_claim_evidence_link(link)
    assert "delta_computed" in exc_info.value.message


def test_verify_increments_revision():
    link = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        signing_secret="s3cr3t",
    )
    # Even though all_pass is False (delta pending), verify raises — so we
    # need a link that would pass. Patch the delta to "computed".

    computed_delta = DeltaSlot(
        status="computed",
        computed_at="2026-05-20T10:05:00Z",
        policy_version_at_claim="pol_v42",
        policy_version_current="pol_v42",
        policy_drift_detected=False,
        schema_version_at_claim="atlasent@2.4.0",
        schema_version_current="atlasent@2.4.0",
        schema_drift_detected=False,
        drift_details=(),
    )
    # Rebuild body dict with computed delta to get a valid hash
    body: dict[str, object] = {
        "version": link.version,
        "link_id": link.link_id,
        "claim_id": link.claim_id,
        "org_id": link.org_id,
        "linked_at": link.linked_at,
        "updated_at": link.updated_at,
        "revision": link.revision,
        "link_algorithm": link.link_algorithm,
        "runtime_evidence": asdict(link.runtime_evidence),
        "deploy_evidence": None,
        "integration_evidence": None,
        "approval_artifact": None,
        "delta": asdict(computed_delta),
        "verification_checklist": asdict(
            VerificationChecklist(
                runtime_evidence_present=True,
                verified_at_claim_time=True,
                verified_at_link_creation=True,
                deploy_evidence_status="not_applicable",
                integration_evidence_status="not_applicable",
                approval_artifact_status="not_applicable",
                delta_computed=True,
                policy_drift_clean=True,
                schema_drift_clean=True,
                all_pass=True,
                last_verified_at="2026-05-20T10:00:00Z",
                computed_at="2026-05-20T10:00:00Z",
            )
        ),
    }
    new_hash = _compute_link_hash(body)
    new_sig = _hmac_sha256_base64url(new_hash, "s3cr3t")

    valid_link = ClaimEvidenceLink(
        version=link.version,
        link_id=link.link_id,
        claim_id=link.claim_id,
        org_id=link.org_id,
        linked_at=link.linked_at,
        updated_at=link.updated_at,
        revision=1,
        link_algorithm="hmac-sha256",
        link_hash=new_hash,
        link_signature=new_sig,
        runtime_evidence=link.runtime_evidence,
        deploy_evidence=None,
        integration_evidence=None,
        approval_artifact=None,
        delta=computed_delta,
        verification_checklist=VerificationChecklist(
            runtime_evidence_present=True,
            verified_at_claim_time=True,
            verified_at_link_creation=True,
            deploy_evidence_status="not_applicable",
            integration_evidence_status="not_applicable",
            approval_artifact_status="not_applicable",
            delta_computed=True,
            policy_drift_clean=True,
            schema_drift_clean=True,
            all_pass=True,
            last_verified_at="2026-05-20T10:00:00Z",
            computed_at="2026-05-20T10:00:00Z",
        ),
    )
    result = verify_claim_evidence_link(valid_link, signing_secret="s3cr3t")
    assert result.valid is True
    assert result.link.revision == 2
    assert result.failed_slots == ()


# ---------------------------------------------------------------------------
# NOT_APPLICABLE sentinel
# ---------------------------------------------------------------------------


def test_not_applicable_sentinel_is_singleton_like():
    assert NOT_APPLICABLE.not_applicable is True
    assert isinstance(NOT_APPLICABLE, NotApplicable)


def test_not_applicable_distinct_from_none():
    link_none = build_claim_evidence_link(claim_id="c", runtime_evidence=make_receipt())
    link_na = build_claim_evidence_link(
        claim_id="c",
        runtime_evidence=make_receipt(),
        deploy_evidence=NOT_APPLICABLE,
    )
    assert link_none.verification_checklist.deploy_evidence_status == "missing"
    assert link_na.verification_checklist.deploy_evidence_status == "not_applicable"


# ---------------------------------------------------------------------------
# canonical_json / hash helpers
# ---------------------------------------------------------------------------


def test_canonical_json_sorts_keys():
    result = _canonical_json({"b": 2, "a": 1})
    assert result == '{"a":1,"b":2}'


def test_canonical_json_null():
    assert _canonical_json(None) == "null"


def test_sha256_hex_length():
    assert len(_sha256_hex("hello")) == 64


def test_hmac_base64url_no_padding():
    sig = _hmac_sha256_base64url("data", "secret")
    assert "=" not in sig
    assert "+" not in sig
    assert "/" not in sig


# ---------------------------------------------------------------------------
# exports reachable from atlasent top-level
# ---------------------------------------------------------------------------


def test_exported_from_atlasent():
    import atlasent

    assert hasattr(atlasent, "build_claim_evidence_link")
    assert hasattr(atlasent, "verify_claim_evidence_link")
    assert hasattr(atlasent, "NOT_APPLICABLE")
    assert hasattr(atlasent, "ClaimEvidenceLink")
    assert hasattr(atlasent, "build_claim_evidence_link_from_action_bundle")


# ---------------------------------------------------------------------------
# build_claim_evidence_link_from_action_bundle
# ---------------------------------------------------------------------------

BUNDLE_RECEIPT_ID = "r-" + "a" * 34
BUNDLE_EVAL_ID = "e-" + "b" * 34
BUNDLE_PERMIT_ID = "pt_live_" + "c" * 24
BUNDLE_AUDIT_HASH = "d" * 64
BUNDLE_SIGNING_SECRET = "s" * 32


def make_action_bundle(**overrides: object) -> ActionBundleInput:
    receipt: ActionBundleReceipt = {
        "receipt_id": BUNDLE_RECEIPT_ID,
        "evaluation_id": BUNDLE_EVAL_ID,
        "permit_id": BUNDLE_PERMIT_ID,
        "audit_hash": BUNDLE_AUDIT_HASH,
        "issued_at": "2026-01-01T00:00:00.000Z",
        "algorithm": "hmac-sha256",
        "signature": "sig-" + "f" * 60,
        "decision": "allow",
    }
    bundle: ActionBundleInput = {
        "bundle_id": "bnd-" + "1" * 32,
        "action": "deploy:production",
        "actor": "github-actions[bot]",
        "environment": "production",
        "repository": "acme/app",
        "sha": "abc1234",
        "run_id": "run-999",
        "generated_at": "2026-01-01T00:00:00.000Z",
        "receipt": receipt,
    }
    bundle.update(overrides)  # type: ignore[typeddict-item]
    return bundle


def test_from_action_bundle_claim_id():
    link = build_claim_evidence_link_from_action_bundle(
        make_action_bundle(), claim_id="claim-123"
    )
    assert link.claim_id == "claim-123"


def test_from_action_bundle_runtime_evidence_fields():
    link = build_claim_evidence_link_from_action_bundle(
        make_action_bundle(), claim_id="c"
    )
    # permit_token = permit_id ?? receipt_id; decision_id = evaluation_id
    assert link.runtime_evidence.permit_token == BUNDLE_PERMIT_ID
    assert link.runtime_evidence.decision_id == BUNDLE_EVAL_ID
    assert link.runtime_evidence.audit_hash == BUNDLE_AUDIT_HASH
    assert link.runtime_evidence.decision == "allow"
    assert link.runtime_evidence.evaluated_at == "2026-01-01T00:00:00.000Z"


def test_from_action_bundle_deploy_evidence_auto_populated():
    link = build_claim_evidence_link_from_action_bundle(
        make_action_bundle(), claim_id="c"
    )
    assert link.deploy_evidence is not None
    assert link.deploy_evidence.sha == "abc1234"
    assert link.deploy_evidence.environment == "production"
    assert link.deploy_evidence.actor_id == "github-actions[bot]"
    assert link.deploy_evidence.deployed_at == "2026-01-01T00:00:00.000Z"
    assert link.verification_checklist.deploy_evidence_status == "present"


def test_from_action_bundle_deploy_not_applicable():
    link = build_claim_evidence_link_from_action_bundle(
        make_action_bundle(), claim_id="c", deploy_not_applicable=True
    )
    assert link.deploy_evidence is None
    assert link.verification_checklist.deploy_evidence_status == "not_applicable"


def test_from_action_bundle_gate_permit_token_uses_permit_id():
    link = build_claim_evidence_link_from_action_bundle(
        make_action_bundle(), claim_id="c"
    )
    assert link.deploy_evidence is not None
    assert link.deploy_evidence.gate_permit_token == BUNDLE_PERMIT_ID


def test_from_action_bundle_gate_permit_token_falls_back_to_receipt_id():
    bundle = make_action_bundle()
    bundle["receipt"] = dict(bundle["receipt"], permit_id=None)  # type: ignore[arg-type]
    link = build_claim_evidence_link_from_action_bundle(bundle, claim_id="c")
    assert link.deploy_evidence is not None
    assert link.deploy_evidence.gate_permit_token == BUNDLE_RECEIPT_ID


def test_from_action_bundle_org_id():
    link = build_claim_evidence_link_from_action_bundle(
        make_action_bundle(), claim_id="c", org_id="org-xyz"
    )
    assert link.org_id == "org-xyz"


def test_from_action_bundle_org_id_default_empty():
    link = build_claim_evidence_link_from_action_bundle(
        make_action_bundle(), claim_id="c"
    )
    assert link.org_id == ""


def test_from_action_bundle_signed():
    link = build_claim_evidence_link_from_action_bundle(
        make_action_bundle(), claim_id="c", signing_secret=BUNDLE_SIGNING_SECRET
    )
    assert link.link_signature is not None
    assert link.link_algorithm == "hmac-sha256"


def test_from_action_bundle_unsigned():
    link = build_claim_evidence_link_from_action_bundle(
        make_action_bundle(), claim_id="c"
    )
    assert link.link_signature is None
    assert link.link_algorithm == "none"


def test_from_action_bundle_wrong_secret_fails_verify():
    link = build_claim_evidence_link_from_action_bundle(
        make_action_bundle(), claim_id="c", signing_secret=BUNDLE_SIGNING_SECRET
    )
    import pytest

    with pytest.raises(AtlaSentError, match="ClaimEvidenceLink verification failed"):
        verify_claim_evidence_link(link, signing_secret="wrong-secret" + "x" * 20)


def test_from_action_bundle_audit_hash_null_becomes_empty():
    bundle = make_action_bundle()
    bundle["receipt"] = dict(bundle["receipt"], audit_hash=None)  # type: ignore[arg-type]
    link = build_claim_evidence_link_from_action_bundle(bundle, claim_id="c")
    assert link.runtime_evidence.audit_hash == ""


def test_from_action_bundle_none_algorithm():
    bundle = make_action_bundle()
    bundle["receipt"] = dict(bundle["receipt"], algorithm="none", signature=None)  # type: ignore[arg-type]
    link = build_claim_evidence_link_from_action_bundle(bundle, claim_id="c")
    assert link.runtime_evidence.algorithm == "none"


def test_from_action_bundle_delta_pending():
    link = build_claim_evidence_link_from_action_bundle(
        make_action_bundle(), claim_id="c"
    )
    assert link.delta.status == "pending"


def test_from_action_bundle_version():
    link = build_claim_evidence_link_from_action_bundle(
        make_action_bundle(), claim_id="c"
    )
    assert link.version == "claim_evidence_link.v1"
