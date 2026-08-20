"""Tests for authentication_assurance (CROSS-016 / proposal 0003).

Mirrors the TypeScript SDK / contract validators so Python, TypeScript, and
the canonical atlasent contract agree on what a "well-formed" assurance
evidence record / requirement is.
"""

from __future__ import annotations

from atlasent import (
    is_authentication_assurance_outcome_code,
    is_authentication_assurance_requirement,
    matches_resource_context_condition,
    validate_authentication_assurance_evidence,
    validate_authentication_assurance_requirement,
)


def test_well_formed_evidence() -> None:
    evidence = {
        "methods": [
            {
                "method": "webauthn",
                "issuer": "https://idp.example.com",
                "verified": True,
            }
        ],
        "factor_count": 2,
        "phishing_resistant": True,
        "auth_time": "2026-08-20T00:00:00Z",
        "issuer": "https://idp.example.com",
        "verification_status": "verified",
        "capability_summary": ["mfa"],
    }
    assert validate_authentication_assurance_evidence(evidence) == []


def test_malformed_evidence_rejected() -> None:
    assert validate_authentication_assurance_evidence("nope") == [
        "input must be a dict"
    ]
    assert validate_authentication_assurance_evidence(None) == ["input must be a dict"]
    problems = validate_authentication_assurance_evidence(
        {
            "methods": "not-a-list",
            "factor_count": -1,
            "phishing_resistant": "yes",
            "auth_time": "not-a-time",
            "issuer": "",
            "verification_status": "maybe",
            "capability_summary": {},
        }
    )
    assert len(problems) > 0
    # bool is not an acceptable factor_count (bool is an int subclass in Python).
    bool_problems = validate_authentication_assurance_evidence(
        {
            "methods": [],
            "factor_count": True,
            "phishing_resistant": True,
            "auth_time": "2026-08-20T00:00:00Z",
            "issuer": "https://idp.example.com",
            "verification_status": "verified",
            "capability_summary": [],
        }
    )
    assert "factor_count must be a non-negative integer" in bool_problems


def test_one_well_formed_requirement_per_layer() -> None:
    external_obligation = {
        "layer": "external_obligation",
        "source_type": "regime_profile",
        "source_id": "regime_1",
        "predicates": [{"predicate_id": "mfa_required", "value": True}],
        "effective_from": "2026-01-01T00:00:00Z",
    }
    organization = {
        "layer": "organization",
        "source_id": "org_1",
        "predicates": [],
        "effective_from": "2026-01-01T00:00:00Z",
        "effective_until": None,
    }
    action_class = {
        "layer": "action_class",
        "source_id": "ac_1",
        "predicates": [{"predicate_id": "phishing_resistant", "value": True}],
        "when": [{"field": "environment", "operator": "eq", "value": "production"}],
        "effective_from": "2026-01-01T00:00:00Z",
    }
    resource_context = {
        "layer": "resource_context",
        "source_id": "rc_1",
        "predicates": [],
        "when": [
            {"field": "target.tier", "operator": "in", "value": ["gold", "platinum"]}
        ],
        "effective_from": "2026-01-01T00:00:00Z",
    }
    for requirement in (
        external_obligation,
        organization,
        action_class,
        resource_context,
    ):
        assert validate_authentication_assurance_requirement(requirement) == []
        assert is_authentication_assurance_requirement(requirement) is True


def test_source_type_forbidden_off_external_obligation() -> None:
    bad = {
        "layer": "organization",
        "source_type": "regime_profile",
        "source_id": "org_1",
        "predicates": [],
        "effective_from": "2026-01-01T00:00:00Z",
    }
    problems = validate_authentication_assurance_requirement(bad)
    assert "source_type must be absent when layer is organization" in problems
    assert is_authentication_assurance_requirement(bad) is False


def test_missing_source_type_on_external_obligation_rejected() -> None:
    bad = {
        "layer": "external_obligation",
        "source_id": "regime_1",
        "predicates": [],
        "effective_from": "2026-01-01T00:00:00Z",
    }
    assert is_authentication_assurance_requirement(bad) is False


def test_resource_context_requires_nonempty_when() -> None:
    missing = {
        "layer": "resource_context",
        "source_id": "rc_1",
        "predicates": [],
        "effective_from": "2026-01-01T00:00:00Z",
    }
    empty = {**missing, "when": []}
    assert is_authentication_assurance_requirement(missing) is False
    assert is_authentication_assurance_requirement(empty) is False


def test_invalid_effective_dates_rejected() -> None:
    bad_from = {
        "layer": "organization",
        "source_id": "org_1",
        "predicates": [],
        "effective_from": "not-a-date",
    }
    bad_until = {
        "layer": "organization",
        "source_id": "org_1",
        "predicates": [],
        "effective_from": "2026-01-01T00:00:00Z",
        "effective_until": "not-a-date",
    }
    assert is_authentication_assurance_requirement(bad_from) is False
    assert is_authentication_assurance_requirement(bad_until) is False


def test_unrecognized_layer_rejected() -> None:
    bad = {
        "layer": "planet",
        "source_id": "x",
        "predicates": [],
        "effective_from": "2026-01-01T00:00:00Z",
    }
    assert is_authentication_assurance_requirement(bad) is False


def test_every_registered_outcome_code_accepted() -> None:
    codes = [
        "ASSURANCE_APPLICABILITY_UNDETERMINED",
        "ASSURANCE_EVIDENCE_MISSING",
        "ASSURANCE_ISSUER_UNTRUSTED",
        "ASSURANCE_EVIDENCE_UNVERIFIED",
        "ASSURANCE_EVIDENCE_SOURCE_CONFLICT",
        "ASSURANCE_EVIDENCE_STALE",
        "ASSURANCE_POLICY_CONFLICT",
        "ASSURANCE_RESOLUTION_INDETERMINATE",
        "ASSURANCE_REQUIREMENT_UNMET",
    ]
    for code in codes:
        assert is_authentication_assurance_outcome_code(code) is True
    assert is_authentication_assurance_outcome_code("ASSURANCE_MADE_UP") is False
    assert is_authentication_assurance_outcome_code(123) is False


def test_matches_resource_context_condition_tri_state() -> None:
    context = {"environment": "production", "tier": "gold"}
    assert (
        matches_resource_context_condition(
            {"field": "environment", "operator": "eq", "value": "production"}, context
        )
        == "match"
    )
    assert (
        matches_resource_context_condition(
            {"field": "environment", "operator": "eq", "value": "staging"}, context
        )
        == "no_match"
    )
    assert (
        matches_resource_context_condition(
            {"field": "tier", "operator": "in", "value": ["gold", "platinum"]}, context
        )
        == "match"
    )
    assert (
        matches_resource_context_condition(
            {"field": "tier", "operator": "in", "value": ["bronze"]}, context
        )
        == "no_match"
    )


def test_matches_resource_context_condition_undetermined_not_silent() -> None:
    context = {"environment": "production"}
    # Missing context key.
    assert (
        matches_resource_context_condition(
            {"field": "missing_field", "operator": "eq", "value": "x"}, context
        )
        == "undetermined"
    )
    # `in` operator with a non-list declared value.
    assert (
        matches_resource_context_condition(
            {"field": "environment", "operator": "in", "value": "production"}, context
        )
        == "undetermined"
    )
