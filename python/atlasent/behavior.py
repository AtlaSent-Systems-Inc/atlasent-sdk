"""Consent + redaction helpers for the v2 Behavior Conditioning Layer.

See ``atlasent-docs/docs/V2_BEHAVIOR_CONDITIONING_LAYER.md`` for the
architecture this module implements.

Quick start::

    from atlasent.behavior import (
        ConsentManager,
        InMemoryBehaviorLedger,
        BehaviorEvent,
        StateSnapshot,
        redact_state_snapshot,
    )

    consent = ConsentManager(user_id="u_123")
    ledger = InMemoryBehaviorLedger(consent=consent, receiver="ledgers-me")

    snapshot = StateSnapshot(
        id="snap_1",
        user_id="u_123",
        emotional_state="overwhelmed",
        intensity=8,
        stress_level=7,
        pressure_level=6,
        body_state="tight",
        cognitive_load=9,
        readiness_level="low",
        confidence_score=0.8,
        created_at="2026-04-26T12:00:00Z",
    )
    summary = redact_state_snapshot(snapshot)

    if consent.can_emit("ledgers-me", "behavior.health.mental"):
        ledger.emit(
            BehaviorEvent(
                user_id=snapshot.user_id,
                source="hicoach",
                category="behavior.health.mental",
                entry_state_summary=summary,
                exit_state_summary=None,
                relief_delta=None,
                confidence_score=1.0,
                timestamp="2026-04-26T12:00:00Z",
            )
        )

The MVP is pure and on-device — no HTTP calls. A future
``RemoteBehaviorLedger`` will POST to ``/v1/behavior/events`` once the
atlasent-api endpoint ships.
"""

from __future__ import annotations

import json
from collections import deque
from dataclasses import dataclass
from typing import Literal, Protocol

# ---------------------------------------------------------------------------
# Sensitive-category vocabulary
# ---------------------------------------------------------------------------

SensitiveCategory = Literal[
    "behavior.health.mental",
    "behavior.health.adherence",
    "behavior.financial",
    "behavior.minor",
]

SENSITIVE_CATEGORIES: tuple[SensitiveCategory, ...] = (
    "behavior.health.mental",
    "behavior.health.adherence",
    "behavior.financial",
    "behavior.minor",
)

# ---------------------------------------------------------------------------
# Domain types — mirror bettyc925/hicoach/lib/hicoach/types.ts
# ---------------------------------------------------------------------------

EmotionalState = Literal[
    "tense",
    "anxious",
    "overwhelmed",
    "flat",
    "frustrated",
    "uncertain",
    "tired",
    "okay",
]

BodyState = Literal[
    "tight",
    "heavy",
    "restless",
    "numb",
    "buzzing",
    "settled",
]

ReadinessLevel = Literal["low", "medium", "high"]


@dataclass(frozen=True)
class StateSnapshot:
    """On-device shape with all raw fields.

    NEVER emitted to a ledger — only the :class:`StateEventSummary`
    projection crosses an app boundary.
    """

    id: str
    user_id: str
    emotional_state: EmotionalState
    intensity: int  # 0..10
    stress_level: int  # 0..10
    pressure_level: int  # 0..10
    body_state: BodyState
    cognitive_load: int  # 0..10
    readiness_level: ReadinessLevel
    confidence_score: float  # 0..1
    created_at: str  # ISO 8601
    note: str | None = None  # NEVER part of the redacted summary


@dataclass(frozen=True)
class StateEventSummary:
    """Redacted projection. The only shape that crosses an app boundary."""

    emotional_state: EmotionalState
    intensity: int
    stress_level: int
    pressure_level: int
    body_state: BodyState
    cognitive_load: int
    readiness_level: ReadinessLevel


@dataclass(frozen=True)
class BehaviorEvent:
    """A behavior event written to the cross-app ledger."""

    user_id: str
    source: str  # "hicoach" | "echobloom" | "ledgers-me" | <other>
    category: SensitiveCategory
    entry_state_summary: StateEventSummary
    exit_state_summary: StateEventSummary | None
    relief_delta: float | None
    confidence_score: float
    timestamp: str  # ISO 8601
    safety_signals: tuple[str, ...] = ()


# ---------------------------------------------------------------------------
# Consent
# ---------------------------------------------------------------------------


@dataclass
class ConsentSettings:
    """Per-user consent settings. Privacy-first defaults."""

    share_state_summaries: bool = False
    private_only_mode: bool = False
    # Optional per-receiver allowlist mapping receiver name to allowed categories.
    receivers: dict | None = None  # type: ignore[type-arg]


DEFAULT_CONSENT: ConsentSettings = ConsentSettings()


class ConsentStorage(Protocol):
    """Storage abstraction so the helper works in-memory or on disk."""

    def get(self, key: str) -> str | None: ...
    def set(self, key: str, value: str) -> None: ...


class MemoryStorage:
    """Default in-memory storage."""

    def __init__(self) -> None:
        self._store: dict = {}

    def get(self, key: str) -> str | None:
        return self._store.get(key)

    def set(self, key: str, value: str) -> None:
        self._store[key] = value


class ConsentManager:
    """Read/write consent settings; gate emissions through ``can_emit``.

    Apps NEVER hand-roll consent checks. This is the only correct way
    to decide whether a :class:`BehaviorEvent` may leave the device.
    """

    def __init__(
        self,
        *,
        user_id: str,
        storage: ConsentStorage | None = None,
        defaults: ConsentSettings | None = None,
    ) -> None:
        self._key = f"atlasent.behavior.consent.{user_id}"
        self._storage = storage or MemoryStorage()
        self._defaults = defaults or DEFAULT_CONSENT

    def get(self) -> ConsentSettings:
        raw = self._storage.get(self._key)
        if not raw:
            return ConsentSettings(
                share_state_summaries=self._defaults.share_state_summaries,
                private_only_mode=self._defaults.private_only_mode,
                receivers=(
                    dict(self._defaults.receivers) if self._defaults.receivers else None
                ),
            )
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return ConsentSettings(
                share_state_summaries=self._defaults.share_state_summaries,
                private_only_mode=self._defaults.private_only_mode,
                receivers=(
                    dict(self._defaults.receivers) if self._defaults.receivers else None
                ),
            )
        return ConsentSettings(
            share_state_summaries=bool(
                data.get(
                    "share_state_summaries",
                    self._defaults.share_state_summaries,
                )
            ),
            private_only_mode=bool(
                data.get("private_only_mode", self._defaults.private_only_mode)
            ),
            receivers=data.get("receivers"),
        )

    def set(
        self,
        *,
        share_state_summaries: bool | None = None,
        private_only_mode: bool | None = None,
        receivers: dict | None = None,  # type: ignore[type-arg]
    ) -> ConsentSettings:
        current = self.get()
        nxt = ConsentSettings(
            share_state_summaries=(
                current.share_state_summaries
                if share_state_summaries is None
                else share_state_summaries
            ),
            private_only_mode=(
                current.private_only_mode
                if private_only_mode is None
                else private_only_mode
            ),
            receivers=(current.receivers if receivers is None else receivers),
        )
        payload = {
            "share_state_summaries": nxt.share_state_summaries,
            "private_only_mode": nxt.private_only_mode,
        }
        if nxt.receivers is not None:
            payload["receivers"] = nxt.receivers
        self._storage.set(self._key, json.dumps(payload))
        return nxt

    def can_emit(self, receiver: str, category: SensitiveCategory) -> bool:
        """Return ``True`` iff a :class:`BehaviorEvent` for ``category``
        may be emitted to ``receiver``.

        ``False`` whenever any of the following holds:

        - ``private_only_mode`` is on.
        - ``share_state_summaries`` is off.
        - A ``receivers`` allowlist exists and the
          ``(receiver, category)`` pair is not in it.
        """
        c = self.get()
        if c.private_only_mode:
            return False
        if not c.share_state_summaries:
            return False
        if c.receivers is not None:
            allowed = c.receivers.get(receiver, [])
            if category not in allowed:
                return False
        return True


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------


def redact_state_snapshot(s: StateSnapshot) -> StateEventSummary:
    """Project a :class:`StateSnapshot` to the redacted summary shape.

    Drops ``id``, ``user_id``, ``created_at``, ``confidence_score``,
    and any ``note`` field. The remaining fields are bounded numeric
    ranges or closed enums and carry no free-form text.
    """
    return StateEventSummary(
        emotional_state=s.emotional_state,
        intensity=s.intensity,
        stress_level=s.stress_level,
        pressure_level=s.pressure_level,
        body_state=s.body_state,
        cognitive_load=s.cognitive_load,
        readiness_level=s.readiness_level,
    )


# ---------------------------------------------------------------------------
# Ledger
# ---------------------------------------------------------------------------


class ConsentDeniedError(Exception):
    """Raised when an emit is blocked by consent settings."""

    code: Literal["consent_denied"] = "consent_denied"

    def __init__(self, receiver: str, category: SensitiveCategory) -> None:
        super().__init__(
            f"Consent denies emit to receiver={receiver} category={category}"
        )
        self.receiver = receiver
        self.category = category


class BehaviorLedger(Protocol):
    """Sink for :class:`BehaviorEvent`. Implementations MUST validate
    consent before persisting and raise :class:`ConsentDeniedError`
    when an event would be persisted in violation of the user's
    settings."""

    def emit(self, event: BehaviorEvent) -> None: ...


class InMemoryBehaviorLedger:
    """On-device ledger for development and demos.

    A future ``RemoteBehaviorLedger`` will POST to atlasent-api's
    ``/v1/behavior/events`` once that endpoint ships.
    """

    def __init__(self, *, consent: ConsentManager, receiver: str = "in-memory") -> None:
        self._consent = consent
        self._receiver = receiver
        self._events: list = []

    def emit(self, event: BehaviorEvent) -> None:
        if not self._consent.can_emit(self._receiver, event.category):
            raise ConsentDeniedError(self._receiver, event.category)
        self._events.append(event)

    def list(self) -> tuple[BehaviorEvent, ...]:
        """Read all events accepted so far. Test/demo helper."""
        return tuple(self._events)

    def clear(self) -> None:
        """Clear the in-memory store. Test helper."""
        self._events.clear()


# ---------------------------------------------------------------------------
# State-event cache
# ---------------------------------------------------------------------------


class StateEventCache:
    """Bounded ring buffer of recent :class:`StateEventSummary` values.

    The LangChain/LlamaIndex middleware (and similar wrappers) read
    this to attach ``context.session_history`` to evaluate calls
    without ever touching raw snapshots.
    """

    def __init__(self, capacity: int = 10) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be > 0")
        self._buf: deque[StateEventSummary] = deque(maxlen=capacity)

    def add(self, summary: StateEventSummary) -> None:
        self._buf.append(summary)

    def recent(self, n: int | None = None) -> tuple[StateEventSummary, ...]:
        items = list(self._buf)
        if n is None:
            return tuple(items)
        return tuple(items[-n:])

    def clear(self) -> None:
        self._buf.clear()


__all__ = [
    "BehaviorEvent",
    "BehaviorLedger",
    "BodyState",
    "ConsentDeniedError",
    "ConsentManager",
    "ConsentSettings",
    "ConsentStorage",
    "DEFAULT_CONSENT",
    "EmotionalState",
    "InMemoryBehaviorLedger",
    "MemoryStorage",
    "ReadinessLevel",
    "SENSITIVE_CATEGORIES",
    "SensitiveCategory",
    "StateEventCache",
    "StateEventSummary",
    "StateSnapshot",
    "redact_state_snapshot",
]
