"""Tests for AtlaSent data models."""

from atlasent.models import AuthorizationResult


class TestAuthorizationResult:
    def test_permitted_result_is_truthy(self):
        result = AuthorizationResult(
            permitted=True,
            decision_id="dec_001",
            reason="Action complies with policy",
            audit_hash="abc123",
            timestamp="2025-01-15T10:30:00Z",
        )
        assert result
        assert bool(result) is True

    def test_denied_result_is_falsy(self):
        result = AuthorizationResult(
            permitted=False,
            decision_id="dec_002",
            reason="Insufficient context",
            audit_hash="def456",
            timestamp="2025-01-15T10:31:00Z",
        )
        assert not result
        assert bool(result) is False

    def test_fields_accessible(self):
        result = AuthorizationResult(
            permitted=True,
            decision_id="dec_003",
            reason="Allowed",
            audit_hash="ghi789",
            timestamp="2025-01-15T10:32:00Z",
        )
        assert result.permitted is True
        assert result.decision_id == "dec_003"
        assert result.reason == "Allowed"
        assert result.audit_hash == "ghi789"
        assert result.timestamp == "2025-01-15T10:32:00Z"

    def test_if_pattern_permitted(self):
        result = AuthorizationResult(
            permitted=True,
            decision_id="dec_004",
            reason="OK",
            audit_hash="jkl012",
            timestamp="2025-01-15T10:33:00Z",
        )
        executed = False
        if result:
            executed = True
        assert executed

    def test_if_pattern_denied(self):
        result = AuthorizationResult(
            permitted=False,
            decision_id="dec_005",
            reason="Denied",
            audit_hash="mno345",
            timestamp="2025-01-15T10:34:00Z",
        )
        executed = False
        if result:
            executed = True
        assert not executed
