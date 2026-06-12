"""Tests for the deny-code constants and helpers."""

from __future__ import annotations

from atlasent import DenyCode, requires_human_approval
from atlasent import __all__ as atlasent_all
from atlasent.exceptions import AtlaSentDenied


def test_human_approval_required_constant() -> None:
    assert DenyCode.HUMAN_APPROVAL_REQUIRED == "HUMAN_APPROVAL_REQUIRED"


def test_requires_human_approval_predicate() -> None:
    assert requires_human_approval("HUMAN_APPROVAL_REQUIRED") is True
    assert requires_human_approval(DenyCode.HUMAN_APPROVAL_REQUIRED) is True
    assert requires_human_approval("SNAPSHOT_REQUIRED") is False
    assert requires_human_approval(None) is False
    assert requires_human_approval("") is False


def test_exception_predicate_true() -> None:
    exc = AtlaSentDenied(
        decision="deny",
        deny_code=DenyCode.HUMAN_APPROVAL_REQUIRED,
        reason="human approval required",
    )
    assert exc.is_human_approval_required is True


def test_exception_predicate_false_for_other_codes() -> None:
    exc = AtlaSentDenied(decision="deny", deny_code=DenyCode.SNAPSHOT_REQUIRED)
    assert exc.is_human_approval_required is False
    exc_none = AtlaSentDenied(decision="deny")
    assert exc_none.is_human_approval_required is False


def test_exports_are_public() -> None:
    assert "DenyCode" in atlasent_all
    assert "requires_human_approval" in atlasent_all


def test_known_codes_are_upper_snake() -> None:
    # Spot-check a few documented codes are present and well-formed.
    for code in (
        DenyCode.SNAPSHOT_REQUIRED,
        DenyCode.NO_AUTHORITY,
        DenyCode.HARD_CONSTRAINT_VIOLATED,
        DenyCode.HUMAN_APPROVAL_REQUIRED,
    ):
        assert code == code.upper()
        assert " " not in code
