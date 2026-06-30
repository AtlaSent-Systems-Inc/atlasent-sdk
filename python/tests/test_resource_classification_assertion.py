"""Tests for ResourceClassificationAssertion (ADR-041 SDK convenience type).

Mirrors the contract / TypeScript SDK validators so all three agree on what a
"well-formed" resource classification assertion is. Also proves the assertion
serializes into the (open) ``resource`` namespace of a context envelope without
any envelope-shape change — the SDK-side of the additive contract change.
"""

from __future__ import annotations

from atlasent import (
    RESOURCE_ASSERTION_TRUST_LEVELS,
    ResourceClassificationAssertion,
    validate_resource_classification_assertion,
)


def test_well_formed_full_and_minimal() -> None:
    full = ResourceClassificationAssertion(
        classification="pci",
        source="partner:inspect-data",
        trust="verified",
        confidence=1.0,
        asserted_at="2026-06-29T12:00:00Z",
        valid_until="2026-07-29T12:00:00Z",
        assertion_id="insp_xyz",
        content_hash="sha256:" + "f" * 64,
    )
    assert full.validate() == []
    assert validate_resource_classification_assertion(full.as_dict()) == []

    minimal = ResourceClassificationAssertion(
        classification="internal", source="caller"
    )
    assert minimal.validate() == []

    # Offset and fractional-second timestamp forms are accepted.
    assert (
        ResourceClassificationAssertion(
            classification="phi",
            source="s",
            asserted_at="2026-06-29T12:00:00+00:00",
            valid_until="2026-06-29T12:00:00.500Z",
        ).validate()
        == []
    )


def test_as_dict_omits_unset_optionals() -> None:
    d = ResourceClassificationAssertion(classification="phi", source="caller").as_dict()
    assert d == {"classification": "phi", "source": "caller"}

    d2 = ResourceClassificationAssertion(
        classification="phi", source="caller", trust="partner_attested", confidence=0.5
    ).as_dict()
    assert d2 == {
        "classification": "phi",
        "source": "caller",
        "trust": "partner_attested",
        "confidence": 0.5,
    }


def test_every_trust_tier_is_accepted() -> None:
    for trust in RESOURCE_ASSERTION_TRUST_LEVELS:
        a = ResourceClassificationAssertion(classification="x", source="s", trust=trust)
        assert a.validate() == []


def test_confidence_bounds() -> None:
    assert (
        ResourceClassificationAssertion(
            classification="x", source="s", confidence=0.0
        ).validate()
        == []
    )
    assert (
        ResourceClassificationAssertion(
            classification="x", source="s", confidence=1.0
        ).validate()
        == []
    )


def test_rejects_non_dict() -> None:
    assert validate_resource_classification_assertion("nope") == [
        "assertion must be a dict"
    ]
    assert validate_resource_classification_assertion(None) == [
        "assertion must be a dict"
    ]
    assert validate_resource_classification_assertion(["x"]) == [
        "assertion must be a dict"
    ]


def test_rejects_malformed_provenance() -> None:
    bad = [
        {"source": "s"},  # missing classification
        {"classification": "", "source": "s"},  # empty classification
        {"classification": "phi"},  # missing source
        {"classification": "phi", "source": ""},  # empty source
        {"classification": "phi", "source": "s", "trust": "totally_trusted"},
        {"classification": "phi", "source": "s", "confidence": 1.5},
        {"classification": "phi", "source": "s", "confidence": -0.1},
        {
            "classification": "phi",
            "source": "s",
            "confidence": True,
        },  # bool is not a number
        {"classification": "phi", "source": "s", "asserted_at": "last tuesday"},
        {"classification": "phi", "source": "s", "valid_until": 12345},
        {"classification": "phi", "source": "s", "assertion_id": ""},
        {"classification": "phi", "source": "s", "content_hash": "md5:abc"},
        {"classification": "phi", "source": "s", "content_hash": "sha256:abc"},
        # Explicit null is rejected for optional fields (matches the TS validator).
        {"classification": "phi", "source": "s", "trust": None},
        {"classification": "phi", "source": "s", "confidence": None},
        {"classification": "phi", "source": "s", "valid_until": None},
        {"classification": "phi", "source": "s", "assertion_id": None},
        {"classification": "phi", "source": "s", "content_hash": None},
        # Impossible calendar date (Feb 30) is rejected, not silently normalized.
        {
            "classification": "phi",
            "source": "s",
            "asserted_at": "2026-02-30T00:00:00Z",
        },
        # Date-only / seconds-less strings are not accepted (full timestamp only).
        {"classification": "phi", "source": "s", "asserted_at": "2026-06-29"},
        # Out-of-range timezone offset (hours 00-23, minutes 00-59).
        {
            "classification": "phi",
            "source": "s",
            "asserted_at": "2026-06-29T12:00:00+99:99",
        },
    ]
    for value in bad:
        problems = validate_resource_classification_assertion(value)
        assert problems, f"expected problems for {value!r}"


def test_serializes_into_open_resource_namespace() -> None:
    # The SDK envelope's `resource` namespace is an open dict — attaching a
    # provenance-bearing assertion needs NO envelope-shape change. This is the
    # SDK-side guarantee of the additive contract change.
    assertion = ResourceClassificationAssertion(
        classification="phi",
        source="partner:inspect-data",
        trust="partner_attested",
        confidence=0.98,
    )
    envelope = {
        "resource": {
            "kind": "customer_record",
            "ref": "crm:account:A_1",
            "classification": ["confidential", "pii"],
            "assertions": [assertion.as_dict()],
        },
    }
    res = envelope["resource"]
    assert res["assertions"][0]["classification"] == "phi"
    assert res["assertions"][0]["source"] == "partner:inspect-data"
    assert validate_resource_classification_assertion(res["assertions"][0]) == []
