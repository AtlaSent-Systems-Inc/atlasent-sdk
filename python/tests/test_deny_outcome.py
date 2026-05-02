"""Tests for D4 — ``AtlaSentDeniedError.outcome`` discriminator.

Covers:
- Each PermitOutcome string is surfaced verbatim and exposes the
  matching ``is_*`` predicate.
- Unknown / "verified" / None outcomes normalize to ``None`` so
  callers don't accidentally match on a Literal that didn't exist
  when the SDK was built.
- ``protect()`` propagates the outcome end-to-end through the verify
  path on both the sync and async clients.

Mirrors TS SDK behaviour planned for the D4 ledger row; the matrix
itself is documented in ``docs/REVOCATION_RUNBOOK.md`` (atlasent
meta) so SDK and runbook stay in sync.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from atlasent import (
    AsyncAtlaSentClient,
    AtlaSentClient,
    AtlaSentDeniedError,
    PermitOutcome,
)
from atlasent.exceptions import _normalize_permit_outcome


def _resp(mocker: Any, status_code: int = 200, json_data: Any | None = None) -> Any:
    r = mocker.Mock(spec=httpx.Response)
    r.status_code = status_code
    r.headers = {}
    r.text = ""
    if json_data is not None:
        r.json.return_value = json_data
    return r


EVALUATE_ALLOW = {
    "permitted": True,
    "decision_id": "dec_alpha",
    "reason": "policy authorized",
    "audit_hash": "hash_alpha",
    "timestamp": "2026-04-29T22:00:00Z",
}


def _verify(outcome: str) -> dict[str, Any]:
    return {
        "verified": False,
        "outcome": outcome,
        "permit_hash": "ph_alpha",
        "timestamp": "2026-04-29T22:00:01Z",
    }


# ─── Outcome normalization ────────────────────────────────────────────


class TestNormalizeOutcome:
    @pytest.mark.parametrize(
        "raw",
        ["permit_consumed", "permit_expired", "permit_revoked", "permit_not_found"],
    )
    def test_known_outcomes_pass_through(self, raw: PermitOutcome) -> None:
        assert _normalize_permit_outcome(raw) == raw

    @pytest.mark.parametrize("raw", [None, "", "verified", "unknown_future_outcome"])
    def test_unknown_outcomes_become_none(self, raw: str | None) -> None:
        # `verified` is the success path on a successful verify and
        # should never reach the deny code path; if a caller does pass
        # it, we still drop to None rather than mis-typing.
        assert _normalize_permit_outcome(raw) is None


# ─── Predicate sugar on AtlaSentDeniedError ───────────────────────────


class TestDeniedErrorPredicates:
    def test_default_outcome_is_none(self) -> None:
        # Constructing with the existing kwargs (no outcome) preserves
        # backward compatibility — pre-D4 callers don't break.
        exc = AtlaSentDeniedError(evaluation_id="dec_x", reason="r")
        assert exc.outcome is None
        assert not exc.is_revoked
        assert not exc.is_expired
        assert not exc.is_consumed
        assert not exc.is_not_found

    @pytest.mark.parametrize(
        "outcome,expected_attr",
        [
            ("permit_revoked", "is_revoked"),
            ("permit_expired", "is_expired"),
            ("permit_consumed", "is_consumed"),
            ("permit_not_found", "is_not_found"),
        ],
    )
    def test_each_outcome_lights_one_predicate(
        self, outcome: PermitOutcome, expected_attr: str
    ) -> None:
        exc = AtlaSentDeniedError(evaluation_id="dec_x", outcome=outcome)
        assert exc.outcome == outcome
        # Exactly one of the predicates is True.
        all_predicates = {"is_revoked", "is_expired", "is_consumed", "is_not_found"}
        true_predicates = {p for p in all_predicates if getattr(exc, p)}
        assert true_predicates == {expected_attr}


# ─── End-to-end propagation through protect() ─────────────────────────


class TestProtectPropagatesOutcomeSync:
    @pytest.mark.parametrize(
        "wire_outcome,expected_outcome,expected_predicate",
        [
            ("permit_consumed", "permit_consumed", "is_consumed"),
            ("permit_expired", "permit_expired", "is_expired"),
            ("permit_revoked", "permit_revoked", "is_revoked"),
            ("permit_not_found", "permit_not_found", "is_not_found"),
        ],
    )
    def test_protect_surfaces_outcome(
        self,
        mocker: Any,
        wire_outcome: str,
        expected_outcome: str,
        expected_predicate: str,
    ) -> None:
        client = AtlaSentClient(api_key="ask_test_x", base_url="https://x")
        post = mocker.patch.object(client._client, "post")
        post.side_effect = [
            _resp(mocker, json_data=EVALUATE_ALLOW),
            _resp(mocker, json_data=_verify(wire_outcome)),
        ]

        with pytest.raises(AtlaSentDeniedError) as excinfo:
            client.protect(agent="a", action="b")

        assert excinfo.value.outcome == expected_outcome
        assert getattr(excinfo.value, expected_predicate) is True

    def test_unknown_wire_outcome_normalizes_to_none(self, mocker: Any) -> None:
        client = AtlaSentClient(api_key="ask_test_x", base_url="https://x")
        post = mocker.patch.object(client._client, "post")
        post.side_effect = [
            _resp(mocker, json_data=EVALUATE_ALLOW),
            _resp(mocker, json_data=_verify("permit_quantum_entangled")),
        ]

        with pytest.raises(AtlaSentDeniedError) as excinfo:
            client.protect(agent="a", action="b")

        # The reason still carries the raw outcome string for
        # debuggability; the discriminator is None so callers
        # branching on `outcome` won't match an unknown literal.
        assert excinfo.value.outcome is None
        assert "permit_quantum_entangled" in excinfo.value.reason


class TestProtectPropagatesOutcomeAsync:
    @pytest.mark.parametrize(
        "wire_outcome, expected_outcome, expected_predicate",
        [
            ("permit_consumed", "permit_consumed", "is_consumed"),
            ("permit_expired", "permit_expired", "is_expired"),
            ("permit_revoked", "permit_revoked", "is_revoked"),
            ("permit_not_found", "permit_not_found", "is_not_found"),
        ],
    )
    @pytest.mark.asyncio
    async def test_async_protect_surfaces_outcome(
        self,
        mocker: Any,
        wire_outcome: str,
        expected_outcome: str,
        expected_predicate: str,
    ) -> None:
        client = AsyncAtlaSentClient(api_key="ask_test_x", base_url="https://x")
        post = mocker.patch.object(client._client, "post")
        post.side_effect = [
            _resp(mocker, json_data=EVALUATE_ALLOW),
            _resp(mocker, json_data=_verify(wire_outcome)),
        ]

        with pytest.raises(AtlaSentDeniedError) as excinfo:
            await client.protect(agent="a", action="b")

        assert excinfo.value.outcome == expected_outcome
        assert getattr(excinfo.value, expected_predicate) is True
