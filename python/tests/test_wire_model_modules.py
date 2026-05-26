"""Coverage-focused tests for standalone wire-model modules."""

from __future__ import annotations

import pytest

from atlasent.auditor_access import (
    AuditorAccessEvent,
    AuditorAccessGrant,
    CreateAuditorGrantRequest,
    CreateAuditorGrantResponse,
    ListAuditorAccessEventsResponse,
    ListAuditorGrantsResponse,
    RevokeAuditorGrantResponse,
)
from atlasent.federation import (
    CreateObserverGrantRequest,
    CreateObserverGrantResponse,
    FederatedApproval,
    FederatedOrg,
    ListFederatedApprovalsResponse,
    ListFederatedOrgsResponse,
    ListObserverGrantsResponse,
    ObserverGrant,
    RegisterFederatedOrgRequest,
    RegisterFederatedOrgResponse,
    RevokeObserverGrantResponse,
    SubmitFederatedApprovalRequest,
    SubmitFederatedApprovalResponse,
    UpdateFederationTrustResponse,
)
from atlasent.financial_governance import (
    FinancialActionClassRecord,
    FinancialExecutionRecord,
    FreezeExecutionRequest,
    FreezeExecutionResponse,
    GenerateLiabilityEvidenceBundleResponse,
    GetLiabilityByExecutionResponse,
    GovernanceHealthScoreResponse,
    IncentiveSignalRecord,
    LiabilityAttributionServerRecord,
    LiabilityEvidenceBundle,
    LiabilityPartyWire,
    ListActionClassesResponse,
    ListExecutionsResponse,
    ListIncentiveSignalsResponse,
    ListLiabilityRecordsResponse,
    ReverseExecutionRequest,
    ReverseExecutionResponse,
    UpdateCeilingRequest,
    UpdateCeilingResponse,
)
from atlasent.hitl import hitl_required_approver_count
from atlasent.policy_certification import (
    CreatePolicyApprovalRequest,
    CreatePolicyApprovalResponse,
    ListPolicyAttestationsResponse,
    ListPolicyVersionsResponse,
    PolicyApproval,
    PolicyAttestation,
    PolicyVersion,
)


def _federated_org() -> dict[str, object]:
    return {
        "federation_id": "fed_1",
        "home_org_id": "org_home",
        "peer_org_id": "org_peer",
        "peer_org_label": "Peer Org",
        "trust_status": "active",
        "registered_by": "user_1",
        "registered_at": "2026-05-08T00:00:00Z",
        "include_in_quorum": True,
    }


def test_federation_models_validate() -> None:
    org = FederatedOrg.model_validate(_federated_org())
    assert org.include_in_quorum is True

    list_resp = ListFederatedOrgsResponse.model_validate(
        {"orgs": [_federated_org()], "total": 1}
    )
    assert list_resp.total == 1

    req = RegisterFederatedOrgRequest.model_validate(
        {
            "peer_org_id": "org_peer",
            "peer_org_label": "Peer Org",
            "include_in_quorum": False,
        }
    )
    assert req.include_in_quorum is False

    reg = RegisterFederatedOrgResponse.model_validate({"org": _federated_org()})
    upd = UpdateFederationTrustResponse.model_validate({"org": _federated_org()})
    assert reg.org.federation_id == upd.org.federation_id

    grant = {
        "observer_grant_id": "og_1",
        "federation_id": "fed_1",
        "home_org_id": "org_home",
        "peer_org_id": "org_peer",
        "observer_principal": "peer:user",
        "observer_label": "Peer User",
        "scopes": ["audit_events"],
        "created_by": "user_1",
        "created_at": "2026-05-08T00:00:00Z",
    }
    assert ObserverGrant.model_validate(grant).active is True
    assert (
        CreateObserverGrantRequest.model_validate(
            {
                "federation_id": "fed_1",
                "observer_principal": "peer:user",
                "observer_label": "Peer User",
                "scopes": ["audit_events", "governance_graph"],
            }
        ).observer_principal
        == "peer:user"
    )
    assert (
        CreateObserverGrantResponse.model_validate(
            {"grant": grant}
        ).grant.observer_grant_id
        == "og_1"
    )
    assert (
        RevokeObserverGrantResponse.model_validate(
            {"grant": grant}
        ).grant.observer_grant_id
        == "og_1"
    )
    assert (
        ListObserverGrantsResponse.model_validate({"grants": [grant], "total": 1}).total
        == 1
    )

    approval = {
        "approval_id": "fa_1",
        "federation_id": "fed_1",
        "home_org_id": "org_home",
        "peer_org_id": "org_peer",
        "subject_type": "financial_execution",
        "subject_id": "exec_1",
        "subject_label": "Wire transfer",
        "status": "pending",
        "requested_by": "user_1",
        "requested_at": "2026-05-08T00:00:00Z",
    }
    assert FederatedApproval.model_validate(approval).status == "pending"
    assert (
        SubmitFederatedApprovalRequest.model_validate(
            {
                "peer_decision": "approve",
                "decided_by": "peer_user",
                "peer_comment": "ok",
            }
        ).peer_decision
        == "approve"
    )
    assert (
        SubmitFederatedApprovalResponse.model_validate(
            {"approval": approval}
        ).approval.approval_id
        == "fa_1"
    )
    assert (
        ListFederatedApprovalsResponse.model_validate(
            {"approvals": [approval], "total": 1}
        ).total
        == 1
    )


def test_financial_governance_models_validate() -> None:
    klass = {
        "class_id": "cls_1",
        "org_id": "org_1",
        "action_type": "wire_transfer",
        "label": "Wire",
        "risk_tier": "high",
        "per_execution_ceiling": 1000,
        "ceiling_currency": "USD",
        "updated_at": "2026-05-08T00:00:00Z",
        "updated_by": "user_1",
    }
    assert FinancialActionClassRecord.model_validate(klass).risk_tier == "high"
    assert (
        ListActionClassesResponse.model_validate({"classes": [klass], "total": 1}).total
        == 1
    )
    assert (
        UpdateCeilingRequest.model_validate(
            {
                "action_type": "wire_transfer",
                "per_execution_ceiling": 500,
                "ceiling_currency": "USD",
                "updated_by": "user_1",
            }
        ).action_type
        == "wire_transfer"
    )
    assert (
        UpdateCeilingResponse.model_validate({"class": klass}).class_.class_id
        == "cls_1"
    )

    execution = {
        "execution_id": "ex_1",
        "org_id": "org_1",
        "agent_id": "agent_1",
        "action_type": "wire_transfer",
        "action_value": 10,
        "currency": "USD",
        "risk_tier": "medium",
        "status": "pending",
        "created_at": "2026-05-08T00:00:00Z",
    }
    assert FinancialExecutionRecord.model_validate(execution).status == "pending"
    assert (
        ListExecutionsResponse.model_validate(
            {"executions": [execution], "total": 1}
        ).total
        == 1
    )
    assert (
        FreezeExecutionRequest.model_validate(
            {"frozen_by": "u", "freeze_reason": "r"}
        ).frozen_by
        == "u"
    )
    assert (
        ReverseExecutionRequest.model_validate(
            {"reversed_by": "u", "reversal_reason": "r"}
        ).reversed_by
        == "u"
    )
    assert (
        FreezeExecutionResponse.model_validate(
            {"execution": execution}
        ).execution.execution_id
        == "ex_1"
    )
    assert (
        ReverseExecutionResponse.model_validate(
            {"execution": execution}
        ).execution.execution_id
        == "ex_1"
    )

    sig = {
        "signal_id": "sig_1",
        "signal_type": "misalignment",
        "party_id": "p1",
        "party_label": "Party",
        "severity": 10,
        "description": "desc",
        "detected_at": "2026-05-08T00:00:00Z",
    }
    assert IncentiveSignalRecord.model_validate(sig).reviewed is False
    assert (
        ListIncentiveSignalsResponse.model_validate(
            {"signals": [sig], "total": 1}
        ).total
        == 1
    )
    assert (
        GovernanceHealthScoreResponse.model_validate(
            {
                "org_id": "org_1",
                "health_score": 97,
                "computed_at": "2026-05-08T00:00:00Z",
            }
        ).open_signal_count
        == 0
    )

    party = {
        "party_id": "u1",
        "party_label": "User",
        "party_type": "human",
        "role": "authorizer",
        "liability_weight": 1.0,
        "acted_at": "2026-05-08T00:00:00Z",
    }
    record = {
        "attribution_id": "attr_1",
        "execution_id": "ex_1",
        "org_id": "org_1",
        "classification": "human_error",
        "risk_tier": "low",
        "liability_chain": [party],
        "chain_hash": "abc",
        "created_at": "2026-05-08T00:00:00Z",
    }
    bundle = {
        "bundle_id": "b_1",
        "attribution_id": "attr_1",
        "execution_id": "ex_1",
        "org_id": "org_1",
        "canonical_chain_json": "{}",
        "chain_hash": "abc",
        "signature": "sig",
        "generated_at": "2026-05-08T00:00:00Z",
    }
    assert LiabilityPartyWire.model_validate(party).party_type == "human"
    assert (
        LiabilityAttributionServerRecord.model_validate(record).attribution_id
        == "attr_1"
    )
    assert (
        ListLiabilityRecordsResponse.model_validate(
            {"records": [record], "total": 1}
        ).total
        == 1
    )
    assert (
        GetLiabilityByExecutionResponse.model_validate(
            {"record": record}
        ).record.execution_id
        == "ex_1"
    )
    assert LiabilityEvidenceBundle.model_validate(bundle).bundle_id == "b_1"
    assert (
        GenerateLiabilityEvidenceBundleResponse.model_validate(
            {"bundle": bundle}
        ).bundle.bundle_id
        == "b_1"
    )


def test_auditor_access_models_validate() -> None:
    grant = {
        "grant_id": "ag_1",
        "org_id": "org_1",
        "auditor_principal": "audit@example.com",
        "auditor_label": "External Auditor",
        "scopes": ["audit_events", "policy_versions"],
        "status": "active",
        "created_by": "user_1",
        "created_at": "2026-05-08T00:00:00Z",
    }
    event = {
        "event_id": "ae_1",
        "grant_id": "ag_1",
        "org_id": "org_1",
        "auditor_principal": "audit@example.com",
        "action": "read_audit_events",
        "occurred_at": "2026-05-08T00:00:00Z",
    }

    assert AuditorAccessGrant.model_validate(grant).status == "active"
    assert (
        CreateAuditorGrantRequest.model_validate(
            {
                "auditor_principal": "audit@example.com",
                "auditor_label": "External Auditor",
                "scopes": ["audit_events"],
            }
        ).auditor_principal
        == "audit@example.com"
    )
    assert (
        CreateAuditorGrantResponse.model_validate({"grant": grant}).grant.grant_id
        == "ag_1"
    )
    assert (
        RevokeAuditorGrantResponse.model_validate({"grant": grant}).grant.grant_id
        == "ag_1"
    )
    assert (
        ListAuditorGrantsResponse.model_validate({"grants": [grant], "total": 1}).total
        == 1
    )
    assert AuditorAccessEvent.model_validate(event).event_id == "ae_1"
    assert (
        ListAuditorAccessEventsResponse.model_validate(
            {"events": [event], "total": 1}
        ).total
        == 1
    )


def test_hitl_required_approver_count_all_branches() -> None:
    assert hitl_required_approver_count("single_approver", 9) == 1
    assert hitl_required_approver_count("simple_majority", 5) == 3
    assert hitl_required_approver_count("two_thirds", 5) == 4
    assert hitl_required_approver_count("unanimous", 5) == 5
    assert hitl_required_approver_count("simple_majority", 0) == 1

    with pytest.raises(ValueError, match="unknown quorum"):
        hitl_required_approver_count("invalid", 3)  # type: ignore[arg-type]


def test_policy_certification_models_validate() -> None:
    version = {
        "version_id": "ver_1",
        "org_id": "org_1",
        "policy_name": "deploy_policy",
        "version_number": 3,
        "status": "pending",
        "body_hash": "hash",
        "submitted_by": "user_1",
        "submitted_at": "2026-05-08T00:00:00Z",
    }
    approval = {
        "approval_id": "pa_1",
        "version_id": "ver_1",
        "org_id": "org_1",
        "approver_id": "user_2",
        "approver_label": "Reviewer",
        "decision": "approve",
        "created_at": "2026-05-08T00:00:00Z",
    }
    attestation = {
        "attestation_id": "att_1",
        "version_id": "ver_1",
        "org_id": "org_1",
        "policy_name": "deploy_policy",
        "version_number": 3,
        "body_hash": "hash",
        "certified_at": "2026-05-08T00:00:00Z",
        "approval_chain_hash": "chain",
    }

    assert PolicyVersion.model_validate(version).status == "pending"
    assert (
        ListPolicyVersionsResponse.model_validate(
            {"versions": [version], "total": 1}
        ).total
        == 1
    )
    assert PolicyApproval.model_validate(approval).decision == "approve"
    assert (
        CreatePolicyApprovalRequest.model_validate(
            {
                "version_id": "ver_1",
                "approver_id": "user_2",
                "approver_label": "Reviewer",
                "decision": "approve",
            }
        ).version_id
        == "ver_1"
    )
    assert (
        CreatePolicyApprovalResponse.model_validate(
            {"approval": approval, "version": version}
        ).version.version_id
        == "ver_1"
    )
    assert PolicyAttestation.model_validate(attestation).attestation_id == "att_1"
    assert (
        ListPolicyAttestationsResponse.model_validate(
            {"attestations": [attestation], "total": 1}
        ).total
        == 1
    )
