"""Tests for atlasent.behavior — consent + redaction MVP."""

from __future__ import annotations

import json
from dataclasses import asdict

import pytest

from atlasent.behavior import (
    SENSITIVE_CATEGORIES,
    BehaviorEvent,
    ConsentDeniedError,
    ConsentManager,
    InMemoryBehaviorLedger,
    MemoryStorage,
    StateEventCache,
    StateEventSummary,
    StateSnapshot,
    redact_state_snapshot,
)


def _sample_snapshot() -> StateSnapshot:
    return StateSnapshot(
        id="snap_1",
        user_id="u_1",
        emotional_state="overwhelmed",
        intensity=8,
        stress_level=7,
        pressure_level=6,
        body_state="tight",
        cognitive_load=9,
        readiness_level="low",
        confidence_score=0.8,
        created_at="2026-04-26T12:00:00Z",
        note="private free-form text that must never leak",
    )


def _sample_event(snapshot: StateSnapshot) -> BehaviorEvent:
    return BehaviorEvent(
        user_id=snapshot.user_id,
        source="hicoach",
        category="behavior.health.mental",
        entry_state_summary=redact_state_snapshot(snapshot),
        exit_state_summary=None,
        relief_delta=None,
        confidence_score=1.0,
        timestamp="2026-04-26T12:00:00Z",
    )


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------


class TestRedactStateSnapshot:
    def test_strips_id_user_id_created_at_confidence_note(self) -> None:
        s = _sample_snapshot()
        summary = redact_state_snapshot(s)
        # Summary fields are exactly the closed enum + bounded numeric set.
        assert set(asdict(summary).keys()) == {
            "emotional_state",
            "intensity",
            "stress_level",
            "pressure_level",
            "body_state",
            "cognitive_load",
            "readiness_level",
        }

    def test_preserves_bounded_fields(self) -> None:
        s = _sample_snapshot()
        summary = redact_state_snapshot(s)
        assert summary == StateEventSummary(
            emotional_state="overwhelmed",
            intensity=8,
            stress_level=7,
            pressure_level=6,
            body_state="tight",
            cognitive_load=9,
            readiness_level="low",
        )

    def test_no_note_text_in_serialised_summary(self) -> None:
        s = _sample_snapshot()
        summary = redact_state_snapshot(s)
        assert "private free-form text" not in json.dumps(asdict(summary))


# ---------------------------------------------------------------------------
# SENSITIVE_CATEGORIES
# ---------------------------------------------------------------------------


def test_sensitive_categories_canonical_set() -> None:
    assert SENSITIVE_CATEGORIES == (
        "behavior.health.mental",
        "behavior.health.adherence",
        "behavior.financial",
        "behavior.minor",
    )


# ---------------------------------------------------------------------------
# ConsentManager
# ---------------------------------------------------------------------------


class TestConsentManager:
    def setup_method(self) -> None:
        self.storage = MemoryStorage()
        self.consent = ConsentManager(user_id="u_1", storage=self.storage)

    def test_first_read_returns_privacy_first_defaults(self) -> None:
        c = self.consent.get()
        assert c.share_state_summaries is False
        assert c.private_only_mode is False

    def test_private_only_mode_blocks_emit(self) -> None:
        self.consent.set(share_state_summaries=True, private_only_mode=True)
        assert self.consent.can_emit("ledgers-me", "behavior.health.mental") is False

    def test_share_off_blocks_even_with_allowlist(self) -> None:
        self.consent.set(
            share_state_summaries=False,
            receivers={"ledgers-me": ["behavior.health.mental"]},
        )
        assert self.consent.can_emit("ledgers-me", "behavior.health.mental") is False

    def test_share_on_no_allowlist_allows_any(self) -> None:
        self.consent.set(share_state_summaries=True)
        assert self.consent.can_emit("ledgers-me", "behavior.health.mental") is True
        assert self.consent.can_emit("anyone", "behavior.financial") is True

    def test_share_on_with_allowlist_denies_non_listed_pairs(self) -> None:
        self.consent.set(
            share_state_summaries=True,
            receivers={"ledgers-me": ["behavior.health.mental"]},
        )
        assert self.consent.can_emit("ledgers-me", "behavior.health.mental") is True
        assert self.consent.can_emit("ledgers-me", "behavior.financial") is False
        assert self.consent.can_emit("other", "behavior.health.mental") is False

    def test_falls_back_to_defaults_on_malformed_json(self) -> None:
        self.storage.set("atlasent.behavior.consent.u_1", "{not-json")
        c = self.consent.get()
        assert c.share_state_summaries is False
        assert c.private_only_mode is False

    def test_persists_via_json(self) -> None:
        self.consent.set(share_state_summaries=True)
        raw = self.storage.get("atlasent.behavior.consent.u_1")
        assert raw is not None
        assert json.loads(raw)["share_state_summaries"] is True

    def test_namespaces_storage_per_user(self) -> None:
        c1 = ConsentManager(user_id="u_1", storage=self.storage)
        c2 = ConsentManager(user_id="u_2", storage=self.storage)
        c1.set(share_state_summaries=True)
        assert c1.get().share_state_summaries is True
        assert c2.get().share_state_summaries is False


# ---------------------------------------------------------------------------
# InMemoryBehaviorLedger
# ---------------------------------------------------------------------------


class TestInMemoryBehaviorLedger:
    def setup_method(self) -> None:
        self.consent = ConsentManager(user_id="u_1", storage=MemoryStorage())
        self.ledger = InMemoryBehaviorLedger(
            consent=self.consent, receiver="ledgers-me"
        )
        self.snapshot = _sample_snapshot()

    def test_raises_when_consent_missing(self) -> None:
        with pytest.raises(ConsentDeniedError):
            self.ledger.emit(_sample_event(self.snapshot))

    def test_persists_when_consent_allows(self) -> None:
        self.consent.set(share_state_summaries=True)
        self.ledger.emit(_sample_event(self.snapshot))
        assert len(self.ledger.list()) == 1

    def test_consent_denied_error_carries_receiver_and_category(self) -> None:
        try:
            self.ledger.emit(_sample_event(self.snapshot))
            pytest.fail("emit should have raised")
        except ConsentDeniedError as err:
            assert err.receiver == "ledgers-me"
            assert err.category == "behavior.health.mental"
            assert err.code == "consent_denied"

    def test_respects_per_receiver_allowlist(self) -> None:
        self.consent.set(
            share_state_summaries=True,
            receivers={"ledgers-me": ["behavior.financial"]},
        )
        with pytest.raises(ConsentDeniedError):
            self.ledger.emit(_sample_event(self.snapshot))
        allowed = BehaviorEvent(
            user_id="u_1",
            source="hicoach",
            category="behavior.financial",
            entry_state_summary=redact_state_snapshot(self.snapshot),
            exit_state_summary=None,
            relief_delta=None,
            confidence_score=1.0,
            timestamp="2026-04-26T12:00:00Z",
        )
        self.ledger.emit(allowed)
        assert len(self.ledger.list()) == 1

    def test_clear_empties_buffer(self) -> None:
        self.consent.set(share_state_summaries=True)
        self.ledger.emit(_sample_event(self.snapshot))
        self.ledger.clear()
        assert self.ledger.list() == ()


# ---------------------------------------------------------------------------
# StateEventCache
# ---------------------------------------------------------------------------


class TestStateEventCache:
    def test_rejects_capacity_le_zero(self) -> None:
        with pytest.raises(ValueError):
            StateEventCache(0)
        with pytest.raises(ValueError):
            StateEventCache(-1)

    def test_evicts_oldest_past_capacity(self) -> None:
        cache = StateEventCache(2)
        snap = _sample_snapshot()
        for i in (1, 2, 3):
            cache.add(
                redact_state_snapshot(StateSnapshot(**{**asdict(snap), "intensity": i}))
            )
        recent = cache.recent()
        assert tuple(s.intensity for s in recent) == (2, 3)

    def test_recent_n_returns_last_n(self) -> None:
        cache = StateEventCache(5)
        snap = _sample_snapshot()
        for i in range(1, 6):
            cache.add(
                redact_state_snapshot(StateSnapshot(**{**asdict(snap), "intensity": i}))
            )
        assert tuple(s.intensity for s in cache.recent(2)) == (4, 5)

    def test_recent_no_arg_returns_all(self) -> None:
        cache = StateEventCache(5)
        cache.add(redact_state_snapshot(_sample_snapshot()))
        cache.add(redact_state_snapshot(_sample_snapshot()))
        assert len(cache.recent()) == 2

    def test_clear_empties_buffer(self) -> None:
        cache = StateEventCache(5)
        cache.add(redact_state_snapshot(_sample_snapshot()))
        cache.clear()
        assert cache.recent() == ()
