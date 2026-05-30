"""Tests for atlasent.runtime_v2 — v2 runtime lifecycle client."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from atlasent import AtlaSentClient
from atlasent.runtime_v2 import (
    AuditChainPage,
    AuthorizationDecision,
    ChainIntegrityReport,
    ComplianceExport,
    PostExecutionResult,
    RuntimeAuditEntry,
    RuntimeV2Client,
    VerificationResult,
    runtime,
)

API_KEY = "ask_test_rv2"
BASE_URL = "https://api.atlasent.io"
ORG = "org_acme"
PERMIT_ID = "permit-uuid-1234"
EVIDENCE_ID = "evidence-uuid-5678"
AUTHORITY_ID = "did:key:z6Mk"


def _client() -> AtlaSentClient:
    return AtlaSentClient(api_key=API_KEY, base_url=BASE_URL, max_retries=0)


def _rv2() -> RuntimeV2Client:
    return runtime(_client())


def _mock_get(body: Any, *, status: int = 200) -> MagicMock:
    m = MagicMock()
    m.status_code = status
    m.json = MagicMock(return_value=body)
    m.text = json.dumps(body)
    m.headers = {"X-Request-ID": "req_test"}
    return m


def _mock_post(body: Any, *, status: int = 200) -> MagicMock:
    return _mock_get(body, status=status)


# ── authorize ─────────────────────────────────────────────────────────────────


def test_authorize_permitted():
    permit = {"permit_id": PERMIT_ID, "status": "ACTIVE"}
    client = _client()
    with patch.object(
        client._client,
        "post",
        return_value=_mock_post({"status": "PERMITTED", "permit": permit}),
    ):
        rv2 = RuntimeV2Client(client)
        result = rv2.authorize(ORG, {"transition": {"from": "idle", "to": "running"}})
    assert isinstance(result, AuthorizationDecision)
    assert result.status == "PERMITTED"
    assert result.permit == permit


def test_authorize_denied():
    client = _client()
    with patch.object(
        client._client,
        "post",
        return_value=_mock_post(
            {
                "status": "DENIED",
                "reasons": ["policy X denied"],
                "policy_ids": ["pol_abc"],
            }
        ),
    ):
        rv2 = RuntimeV2Client(client)
        result = rv2.authorize(ORG, {})
    assert result.status == "DENIED"
    assert "policy X denied" in result.reasons
    assert result.permit is None


def test_authorize_pending():
    client = _client()
    with patch.object(
        client._client,
        "post",
        return_value=_mock_post(
            {
                "status": "PENDING_APPROVAL",
                "permit": {"permit_id": PERMIT_ID},
                "required_approvers": ["did:key:approver1"],
            }
        ),
    ):
        rv2 = RuntimeV2Client(client)
        result = rv2.authorize(ORG, {})
    assert result.status == "PENDING_APPROVAL"
    assert "did:key:approver1" in result.required_approvers


# ── get_permit ────────────────────────────────────────────────────────────────


def test_get_permit_found():
    permit = {"permit_id": PERMIT_ID, "status": "ACTIVE"}
    client = _client()
    with patch.object(
        client._client, "get", return_value=_mock_get({"permit": permit})
    ):
        rv2 = RuntimeV2Client(client)
        result = rv2.get_permit(ORG, PERMIT_ID)
    assert result == permit


def test_get_permit_not_found():
    client = _client()
    with patch.object(client._client, "get", return_value=_mock_get({"permit": None})):
        rv2 = RuntimeV2Client(client)
        result = rv2.get_permit(ORG, PERMIT_ID)
    assert result is None


# ── consume ───────────────────────────────────────────────────────────────────


def test_consume_passed():
    client = _client()
    body = {
        "passed": True,
        "verified_at": "2026-05-30T07:00:00Z",
        "failures": [],
        "warnings": [],
    }
    with patch.object(client._client, "post", return_value=_mock_post(body)):
        rv2 = RuntimeV2Client(client)
        result = rv2.consume(ORG, PERMIT_ID, "sha256:abc")
    assert isinstance(result, VerificationResult)
    assert result.passed is True
    assert result.failures == ()


def test_consume_failed_state_mismatch():
    client = _client()
    body = {
        "passed": False,
        "verified_at": "2026-05-30T07:00:00Z",
        "failures": [{"code": "SOURCE_STATE_MISMATCH", "message": "state mismatch"}],
        "warnings": [],
    }
    with patch.object(client._client, "post", return_value=_mock_post(body)):
        rv2 = RuntimeV2Client(client)
        result = rv2.consume(ORG, PERMIT_ID, "sha256:wrong")
    assert result.passed is False
    assert result.failures[0].code == "SOURCE_STATE_MISMATCH"


# ── approve ───────────────────────────────────────────────────────────────────


def test_approve_returns_status():
    client = _client()
    with patch.object(
        client._client,
        "post",
        return_value=_mock_post({"approved": True, "status": "ACTIVE"}),
    ):
        rv2 = RuntimeV2Client(client)
        result = rv2.approve(ORG, PERMIT_ID, "did:key:z6Mk", "sig_abc", comment="lgtm")
    assert result["approved"] is True
    assert result["status"] == "ACTIVE"


# ── complete ──────────────────────────────────────────────────────────────────


def test_complete_verified():
    client = _client()
    body = {
        "verified": True,
        "evidence_completeness": "COMPLETE",
        "failures": [],
        "receipt": {
            "receipt_id": "rcpt-1",
            "permit_id": PERMIT_ID,
            "org_id": ORG,
            "issued_at": "2026-05-30T07:00:00Z",
            "post_state_fingerprint": "sha256:post",
            "evidence_id": EVIDENCE_ID,
        },
    }
    with patch.object(client._client, "post", return_value=_mock_post(body)):
        rv2 = RuntimeV2Client(client)
        result = rv2.complete(ORG, PERMIT_ID, EVIDENCE_ID, "sha256:post")
    assert isinstance(result, PostExecutionResult)
    assert result.verified is True
    assert result.receipt is not None
    assert result.receipt.receipt_id == "rcpt-1"
    assert result.evidence_completeness == "COMPLETE"


# ── authorities ───────────────────────────────────────────────────────────────


def test_list_authorities():
    auth = {
        "authority_id": AUTHORITY_ID,
        "org_id": ORG,
        "name": "Root",
        "action_classes": ["DEPLOY"],
        "public_key": "pk",
        "key_id": "kid",
        "status": "ACTIVE",
        "created_at": "2026-01-01T00:00:00Z",
    }
    client = _client()
    with patch.object(
        client._client, "get", return_value=_mock_get({"authorities": [auth]})
    ):
        rv2 = RuntimeV2Client(client)
        result = rv2.list_authorities(ORG)
    assert len(result) == 1
    assert result[0].authority_id == AUTHORITY_ID


def test_get_authority_found():
    auth = {
        "authority_id": AUTHORITY_ID,
        "org_id": ORG,
        "name": "Root",
        "action_classes": [],
        "public_key": "pk",
        "key_id": "kid",
        "status": "ACTIVE",
        "created_at": "2026-01-01T00:00:00Z",
    }
    client = _client()
    with patch.object(
        client._client, "get", return_value=_mock_get({"authority": auth})
    ):
        rv2 = RuntimeV2Client(client)
        result = rv2.get_authority(ORG, AUTHORITY_ID)
    assert result is not None
    assert result.authority_id == AUTHORITY_ID


def test_get_authority_not_found():
    client = _client()
    with patch.object(
        client._client, "get", return_value=_mock_get({"authority": None})
    ):
        rv2 = RuntimeV2Client(client)
        result = rv2.get_authority(ORG, AUTHORITY_ID)
    assert result is None


# ── evidence & audit chain ────────────────────────────────────────────────────


def test_get_evidence_found():
    pkg = {"evidence_id": EVIDENCE_ID, "permit_id": PERMIT_ID}
    client = _client()
    with patch.object(client._client, "get", return_value=_mock_get({"evidence": pkg})):
        rv2 = RuntimeV2Client(client)
        result = rv2.get_evidence(ORG, EVIDENCE_ID)
    assert result == pkg


def test_query_audit_chain():
    entry = {
        "entry_id": "entry-1",
        "org_id": ORG,
        "sequence": 1,
        "receipt_id": "rcpt-1",
        "prior_hash": "0" * 64,
        "entry_hash": "a" * 64,
        "appended_at": "2026-05-30T07:00:00Z",
    }
    client = _client()
    body = {"entries": [entry], "total": 1, "page": 1, "page_size": 100}
    with patch.object(client._client, "get", return_value=_mock_get(body)):
        rv2 = RuntimeV2Client(client)
        result = rv2.query_audit_chain(
            ORG, "2026-05-01T00:00:00Z", "2026-05-31T00:00:00Z"
        )
    assert isinstance(result, AuditChainPage)
    assert result.total == 1
    assert isinstance(result.entries[0], RuntimeAuditEntry)
    assert result.entries[0].sequence == 1


def test_verify_chain_integrity_valid():
    body = {
        "valid": True,
        "checked_entries": 10,
        "first_sequence": 1,
        "last_sequence": 10,
        "gaps": [],
        "invalid_hashes": [],
        "verified_at": "2026-05-30T07:00:00Z",
    }
    client = _client()
    with patch.object(client._client, "get", return_value=_mock_get(body)):
        rv2 = RuntimeV2Client(client)
        result = rv2.verify_chain_integrity(ORG, 1, 10)
    assert isinstance(result, ChainIntegrityReport)
    assert result.valid is True
    assert result.checked_entries == 10
    assert result.gaps == ()


def test_export_compliance():
    body = {
        "export_id": "exp-1",
        "org_id": ORG,
        "from": "2026-05-01T00:00:00Z",
        "to": "2026-05-31T00:00:00Z",
        "entry_count": 42,
        "format": "JSON",
        "content_ref": "s3://bucket/export.json",
        "content_hash": "sha256:abc",
        "generated_at": "2026-05-30T07:00:00Z",
        "signed_by": "did:key:root",
    }
    client = _client()
    with patch.object(client._client, "post", return_value=_mock_post(body)):
        rv2 = RuntimeV2Client(client)
        result = rv2.export_compliance(
            ORG, "2026-05-01T00:00:00Z", "2026-05-31T00:00:00Z"
        )
    assert isinstance(result, ComplianceExport)
    assert result.entry_count == 42
    assert result.format == "JSON"


# ── revoke_permit ─────────────────────────────────────────────────────────────


def test_revoke_permit_success():
    client = _client()
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json = MagicMock(return_value={})
    with patch.object(client._client, "request", return_value=mock_resp):
        rv2 = RuntimeV2Client(client)
        rv2.revoke_permit(ORG, PERMIT_ID, "did:key:revoker", "policy violation")


def test_revoke_permit_with_propagation():
    client = _client()
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json = MagicMock(return_value={})
    with patch.object(client._client, "request", return_value=mock_resp) as mock_req:
        rv2 = RuntimeV2Client(client)
        rv2.revoke_permit(
            ORG, PERMIT_ID, "did:key:revoker", "expired", propagates_to_children=True
        )
    import json

    body = json.loads(mock_req.call_args.kwargs.get("content", b"{}"))
    assert body["propagates_to_children"] is True


def test_revoke_permit_error():
    from atlasent.exceptions import AtlaSentError

    client = _client()
    mock_resp = MagicMock()
    mock_resp.status_code = 404
    mock_resp.json = MagicMock(
        return_value={"error": {"code": "not_found", "message": "permit not found"}}
    )
    with patch.object(client._client, "request", return_value=mock_resp):
        rv2 = RuntimeV2Client(client)
        with pytest.raises(AtlaSentError):
            rv2.revoke_permit(ORG, "bad-id", "did:key:r", "reason")


# ── create_authority / rotate_authority / revoke_authority ────────────────────


def test_create_authority():
    auth = {
        "authority_id": AUTHORITY_ID,
        "org_id": ORG,
        "name": "New",
        "action_classes": ["DEPLOY"],
        "public_key": "pk",
        "key_id": "kid",
        "status": "ACTIVE",
        "created_at": "2026-01-01T00:00:00Z",
    }
    client = _client()
    with patch.object(
        client._client, "post", return_value=_mock_post({"authority": auth})
    ):
        rv2 = RuntimeV2Client(client)
        result = rv2.create_authority(
            ORG,
            {
                "name": "New",
                "action_classes": ["DEPLOY"],
                "public_key": "pk",
                "key_id": "kid",
            },
        )
    assert result.authority_id == AUTHORITY_ID
    assert result.name == "New"


def test_rotate_authority():
    auth = {
        "authority_id": AUTHORITY_ID,
        "org_id": ORG,
        "name": "Root",
        "action_classes": [],
        "public_key": "new_pk",
        "key_id": "new_kid",
        "status": "ACTIVE",
        "created_at": "2026-01-01T00:00:00Z",
    }
    client = _client()
    with patch.object(
        client._client, "post", return_value=_mock_post({"authority": auth})
    ):
        rv2 = RuntimeV2Client(client)
        result = rv2.rotate_authority(ORG, AUTHORITY_ID, "new_pk", "new_kid")
    assert result.public_key == "new_pk"
    assert result.key_id == "new_kid"


def test_revoke_authority():
    client = _client()
    with patch.object(client._client, "post", return_value=_mock_post({})):
        rv2 = RuntimeV2Client(client)
        rv2.revoke_authority(ORG, AUTHORITY_ID, "key compromised")


# ── submit_evidence ───────────────────────────────────────────────────────────


def test_submit_evidence():
    pkg = {
        "evidence_id": EVIDENCE_ID,
        "permit_id": PERMIT_ID,
        "org_id": ORG,
        "observations": [],
        "collected_at": "2026-05-30T07:00:00Z",
    }
    client = _client()
    with patch.object(client._client, "post", return_value=_mock_post({})):
        rv2 = RuntimeV2Client(client)
        rv2.submit_evidence(ORG, pkg)  # should not raise


def test_query_audit_chain_with_filters():
    client = _client()
    body = {"entries": [], "total": 0, "page": 1, "page_size": 50}
    with patch.object(client._client, "get", return_value=_mock_get(body)):
        rv2 = RuntimeV2Client(client)
        result = rv2.query_audit_chain(
            ORG,
            "2026-05-01T00:00:00Z",
            "2026-05-31T00:00:00Z",
            page=1,
            page_size=50,
            action_class="DEPLOY",
            principal_did="did:key:x",
        )
    assert result.total == 0
    assert result.page_size == 50


# ── factory ───────────────────────────────────────────────────────────────────


def test_runtime_factory():
    c = _client()
    rv2 = runtime(c)
    assert isinstance(rv2, RuntimeV2Client)
