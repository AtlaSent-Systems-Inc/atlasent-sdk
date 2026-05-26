"""Tests for atlasent.governance.liability_attribution.

Focus on the parity-relevant behaviors: 8-role taxonomy, role weight
numeric values, weight normalization, chain validation, primary-party
query, deterministic chain hash.
"""

from __future__ import annotations

from atlasent.governance import (
    ROLE_WEIGHTS,
    LiabilityAttributionInput,
    LiabilityParty,
    build_liability_chain,
    compute_chain_hash,
    compute_liability_weights,
    find_primary_liability_parties,
    validate_liability_chain,
)
from atlasent.governance.liability_attribution import (
    DelegationInput,
    OverrideInput,
    _PartyInput,
)


def test_role_weights_lock_canonical_values() -> None:
    # These numbers are the contract. Changing them is a wire-breaking event.
    assert ROLE_WEIGHTS == {
        "authorizer": 0.30,
        "delegator": 0.15,
        "delegate": 0.15,
        "executor": 0.25,
        "approver": 0.05,
        "override_actor": 0.40,
        "supervisor": 0.10,
        "exception_approver": 0.05,
    }


def test_compute_weights_normalizes_to_one() -> None:
    parties = [{"role": "authorizer"}, {"role": "executor"}]
    weights = compute_liability_weights(parties)
    assert abs(sum(weights) - 1.0) < 1e-9
    # 0.30 / (0.30 + 0.25) and 0.25 / (0.30 + 0.25)
    assert abs(weights[0] - (0.30 / 0.55)) < 1e-9
    assert abs(weights[1] - (0.25 / 0.55)) < 1e-9


def test_compute_weights_equal_distribution() -> None:
    parties = [{"role": "approver"}] * 4
    weights = compute_liability_weights(parties, distribution="equal")
    assert weights == [0.25, 0.25, 0.25, 0.25]


def test_compute_weights_unknown_role_falls_back() -> None:
    parties = [{"role": "made_up_role"}, {"role": "executor"}]
    weights = compute_liability_weights(parties)
    # 0.05 fallback + 0.25 executor; normalized.
    assert abs(weights[0] - (0.05 / 0.30)) < 1e-9
    assert abs(weights[1] - (0.25 / 0.30)) < 1e-9


def _party(party_id: str) -> _PartyInput:
    return _PartyInput(
        party_id=party_id,
        party_label=party_id.upper(),
        party_type="human",
        acted_at="2026-05-08T12:00:00Z",
        permit_id=None,
    )


def test_build_chain_minimal() -> None:
    inp = LiabilityAttributionInput(
        execution_id="exec_1",
        org_id="org_x",
        classification="shared",
        risk_tier="medium",
        authorizer=_party("alice"),
        executor=_party("bob"),
    )
    chain = build_liability_chain(inp)
    assert [p.role for p in chain] == ["authorizer", "executor"]
    assert abs(sum(p.liability_weight for p in chain) - 1.0) < 1e-9


def test_build_chain_full_with_override() -> None:
    inp = LiabilityAttributionInput(
        execution_id="exec_2",
        org_id="org_x",
        classification="emergency_override",
        risk_tier="critical",
        authorizer=_party("alice"),
        executor=_party("bob"),
        approvers=(_party("charlie"), _party("diana")),
        delegations=(
            DelegationInput(
                delegator_id="alice",
                delegate_id="eve",
                delegator_label="ALICE",
                delegate_label="EVE",
                delegator_type="human",
                delegate_type="human",
                permit_id=None,
                acted_at="2026-05-08T11:30:00Z",
            ),
        ),
        supervisors=(_party("frank"),),
        override=OverrideInput(
            actor_id="grace",
            actor_label="GRACE",
            actor_type="human",
            justification="emergency wire to clear settlement",
            permit_id=None,
            acted_at="2026-05-08T11:59:00Z",
        ),
    )
    chain = build_liability_chain(inp)
    # Order MUST be: authorizer, delegator, delegate,
    # approvers..., supervisors..., executor, override_actor.
    assert [p.role for p in chain] == [
        "authorizer",
        "delegator",
        "delegate",
        "approver",
        "approver",
        "supervisor",
        "executor",
        "override_actor",
    ]
    assert abs(sum(p.liability_weight for p in chain) - 1.0) < 1e-9


def test_validate_rejects_empty_chain() -> None:
    result = validate_liability_chain((), has_emergency_override=False)
    assert result.valid is False


def test_validate_requires_override_actor_when_emergency() -> None:
    chain = [
        LiabilityParty(
            party_id="alice",
            party_label="ALICE",
            party_type="human",
            role="authorizer",
            liability_weight=0.5,
            acted_at="2026-05-08T12:00:00Z",
            permit_id=None,
        ),
        LiabilityParty(
            party_id="bob",
            party_label="BOB",
            party_type="human",
            role="executor",
            liability_weight=0.5,
            acted_at="2026-05-08T12:00:00Z",
            permit_id=None,
        ),
    ]
    result = validate_liability_chain(chain, has_emergency_override=True)
    assert result.valid is False
    assert any("override_actor" in e for e in result.errors)


def test_validate_rejects_duplicate_party_role() -> None:
    chain = [
        LiabilityParty(
            party_id="alice",
            party_label="ALICE",
            party_type="human",
            role="approver",
            liability_weight=0.5,
            acted_at="2026-05-08T12:00:00Z",
            permit_id=None,
        ),
        LiabilityParty(
            party_id="alice",
            party_label="ALICE",
            party_type="human",
            role="approver",
            liability_weight=0.5,
            acted_at="2026-05-08T12:01:00Z",
            permit_id=None,
        ),
    ]
    result = validate_liability_chain(chain, has_emergency_override=False)
    assert result.valid is False
    assert any("duplicate party+role" in e for e in result.errors)


def test_find_primary_returns_all_above_threshold() -> None:
    chain = [
        LiabilityParty(
            party_id="a",
            party_label="A",
            party_type="human",
            role="authorizer",
            liability_weight=0.40,
            acted_at="",
            permit_id=None,
        ),
        LiabilityParty(
            party_id="b",
            party_label="B",
            party_type="human",
            role="executor",
            liability_weight=0.30,
            acted_at="",
            permit_id=None,
        ),
        LiabilityParty(
            party_id="c",
            party_label="C",
            party_type="human",
            role="approver",
            liability_weight=0.10,
            acted_at="",
            permit_id=None,
        ),
        LiabilityParty(
            party_id="d",
            party_label="D",
            party_type="human",
            role="approver",
            liability_weight=0.20,
            acted_at="",
            permit_id=None,
        ),
    ]
    primary = find_primary_liability_parties(chain, threshold=0.20)
    # Returns a, b, d (all >= 0.20). NOT just the highest — unlike the
    # legacy module's primary_accountable.
    assert {p.party_id for p in primary} == {"a", "b", "d"}


def test_chain_hash_is_deterministic() -> None:
    inp = LiabilityAttributionInput(
        execution_id="exec_3",
        org_id="org_x",
        classification="individual",
        risk_tier="low",
        authorizer=_party("alice"),
        executor=_party("bob"),
    )
    chain1 = build_liability_chain(inp)
    chain2 = build_liability_chain(inp)
    assert compute_chain_hash(chain1) == compute_chain_hash(chain2)


def test_chain_hash_differs_on_role_swap() -> None:
    inp1 = LiabilityAttributionInput(
        execution_id="exec_a",
        org_id="org_x",
        classification="individual",
        risk_tier="low",
        authorizer=_party("alice"),
        executor=_party("bob"),
    )
    inp2 = LiabilityAttributionInput(
        execution_id="exec_a",
        org_id="org_x",
        classification="individual",
        risk_tier="low",
        authorizer=_party("bob"),  # swapped
        executor=_party("alice"),
    )
    h1 = compute_chain_hash(build_liability_chain(inp1))
    h2 = compute_chain_hash(build_liability_chain(inp2))
    assert h1 != h2
