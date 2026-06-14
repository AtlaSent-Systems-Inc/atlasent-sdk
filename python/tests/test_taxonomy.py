"""Tests for the canonical authorization taxonomy module."""

import atlasent

t = atlasent.taxonomy


def test_canonical_counts_and_version():
    import re

    assert re.match(r"^\d+\.\d+\.\d+$", t.TAXONOMY_SCHEMA_VERSION)
    assert len(t.ACTION_CLASS_FAMILIES) == 10
    assert len(t.CONDITION_TYPES) == 26
    assert len(t.REASON_CODES) == 31


def test_family_for_slug():
    assert t.family_for_slug("vendor.payment.release") == "financial.transaction"
    assert t.family_for_slug("production.deploy") == "production.deploy"
    assert t.family_for_slug("nope.unknown") is None


def test_get_reason_code():
    r = t.get_reason_code("SNAPSHOT_REQUIRED")
    assert r is not None
    assert r["severity"] == "error"
    assert r["retry_advice"] == "with_modified_input"
    assert t.get_reason_code("NOT_A_CODE") is None


def test_membership_guards():
    assert t.is_action_class_family_id("production.deploy")
    assert not t.is_action_class_family_id("nope.nope")
    assert t.is_condition_type_id("approval_required")
    assert not t.is_condition_type_id("nope")
    assert t.is_reason_code("INSUFFICIENT_APPROVALS")
    assert not t.is_reason_code("nope")


def test_internal_consistency():
    for fam in t.ACTION_CLASS_FAMILIES:
        for cond in fam["typical_conditions"]:
            assert t.is_condition_type_id(cond), f"{fam['family_id']} -> unknown {cond}"
    for cond in t.CONDITION_TYPES:
        for code in cond["produces_reason_code"]:
            assert t.is_reason_code(code), f"{cond['condition_id']} -> unknown {code}"


def test_exported_from_package():
    assert atlasent.family_for_slug("production.deploy") == "production.deploy"
    assert "TAXONOMY_SCHEMA_VERSION" in atlasent.__all__
