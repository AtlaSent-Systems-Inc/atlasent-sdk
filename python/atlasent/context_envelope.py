"""context_envelope — V1 context envelope types.

Python mirror of the TypeScript ``contextEnvelope.ts`` module. Provides
structured types for the canonical V1 context envelope that powers
execution-time authorization decisions.

These types mirror the DB schema introduced in migration
``20260522070000_context_envelope_v1.sql``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

# Canonical V1 envelope top-level namespace keys.
CONTEXT_NAMESPACES: tuple[str, ...] = (
    "intent",
    "actor",
    "resource",
    "environment",
    "history",
    "evidence_refs",
    "signals",
    "compatibility_overrides",
)

ContextNamespaceKey = Literal[
    "intent",
    "actor",
    "resource",
    "environment",
    "history",
    "evidence_refs",
    "signals",
    "compatibility_overrides",
]


@dataclass(frozen=True)
class ContextNamespaceEntry:
    """One row from ``context_namespace_registry``."""

    namespace: ContextNamespaceKey
    purpose: str
    owner: str
    is_signal: bool
    """``True`` for the ``signals`` namespace — derived / inferred inputs."""
    introduced_in_version: str


@dataclass(frozen=True)
class ContextSignal:
    """One signal attached to a context envelope."""

    namespace: str
    """Dotted path under the ``signals`` namespace (e.g. ``"signals.actor_anomaly"``)."""

    source: str
    """Named source that produced this signal."""

    payload: dict[str, Any]
    """Arbitrary signal payload."""

    produced_at: str
    """ISO-8601 timestamp when the signal was produced."""

    confidence: float | None = None
    """Confidence in [0.0, 1.0]. ``None`` when not reported."""

    ttl_seconds: int | None = None
    """Seconds until the signal is stale. ``None`` = no expiry."""


@dataclass(frozen=True)
class ContextEnvelope:
    """A canonical V1 context envelope.

    The deterministic input set that powers execution-time authorization
    decisions. Envelopes are append-only and hash-committed:
    ``envelope_hash`` is SHA-256 of the canonical JSON form.

    The permit issued by the evaluator commits to this hash so the audit
    chain, the permit, and a verifier all agree on what was evaluated.

    Example::

        from atlasent import ContextEnvelope

        envelope = ContextEnvelope(
            request_id="req_abc123",
            org_id="org_xyz",
            envelope_version="atlasent.v1",
            protected_action="production.deploy",
            envelope={
                "intent": {"action": "deploy", "summary": "Release v1.2.0"},
                "actor": {"id": "agent:deploy-bot", "roles": ["deploy"]},
                "environment": {"name": "production", "freeze_window": False},
            },
            envelope_hash="a3f...",
            evidence_refs=(),
            recorded_by="v1-evaluate",
            received_at="2026-06-02T00:00:00Z",
            signals=(),
        )
    """

    request_id: str
    """Caller-supplied idempotency / correlation key."""

    org_id: str
    envelope_version: Literal["atlasent.v1"]
    protected_action: str
    """The namespaced action type this envelope covers."""

    envelope: dict[str, Any]
    """The full validated envelope payload. Top-level keys should be in
    ``CONTEXT_NAMESPACES``. Unknown keys are warn-only in V1."""

    envelope_hash: str
    """SHA-256 hex of ``canonical-JSON(envelope)``. 64 hex chars."""

    evidence_refs: tuple[str, ...] = field(default_factory=tuple)
    """UUIDs of governance evidence rows referenced by this envelope."""

    recorded_by: str = "v1-evaluate"
    """Which handler wrote this row."""

    received_at: str = ""
    """ISO-8601 timestamp."""

    signals: tuple[ContextSignal, ...] = field(default_factory=tuple)
    """Signals attached to this envelope."""


@dataclass
class RecordContextEnvelopeInput:
    """Minimal input shape for recording a context envelope."""

    request_id: str
    org_id: str
    protected_action: str
    envelope: dict[str, Any]
    envelope_hash: str
    envelope_version: Literal["atlasent.v1"] = "atlasent.v1"
    evidence_refs: list[str] = field(default_factory=list)
    recorded_by: str = "v1-evaluate"
    signals: list[ContextSignal] = field(default_factory=list)


__all__ = [
    "CONTEXT_NAMESPACES",
    "ContextEnvelope",
    "ContextNamespaceEntry",
    "ContextNamespaceKey",
    "ContextSignal",
    "RecordContextEnvelopeInput",
]
