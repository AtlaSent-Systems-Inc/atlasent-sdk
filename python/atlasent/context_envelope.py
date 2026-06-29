"""context_envelope — V1 context envelope types.

Python mirror of the TypeScript ``contextEnvelope.ts`` module. Provides
structured types for the canonical V1 context envelope that powers
execution-time authorization decisions.

These types mirror the DB schema introduced in migration
``20260522070000_context_envelope_v1.sql``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
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
    """Dotted path under the ``signals`` namespace.

    Example: ``"signals.actor_anomaly"``.
    """

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


# Trust tiers for a resource classification assertion (mirrors the contract
# ResourceAssertionTrust). Absent ⇒ treat as ``caller_asserted``.
RESOURCE_ASSERTION_TRUST_LEVELS: tuple[str, ...] = (
    "caller_asserted",
    "partner_attested",
    "verified",
)

_SHA256_PREFIXED = re.compile(r"^sha256:[0-9a-f]{64}$")


def _is_iso8601(value: str) -> bool:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def validate_resource_classification_assertion(value: Any) -> list[str]:
    """Validate a resource classification assertion (dict form).

    Returns a list of human-readable problems; an empty list means the
    assertion is well-formed. Only ``classification`` and ``source`` are
    required. Mirrors ``validateResourceClassificationAssertion`` in the
    contract / TypeScript SDK so all three agree on "well-formed".
    """
    if not isinstance(value, dict):
        return ["assertion must be a dict"]
    problems: list[str] = []
    classification = value.get("classification")
    if not isinstance(classification, str) or not classification:
        problems.append("classification is required and must be a non-empty string")
    source = value.get("source")
    if not isinstance(source, str) or not source:
        problems.append("source is required and must be a non-empty string")
    trust = value.get("trust")
    if trust is not None and trust not in RESOURCE_ASSERTION_TRUST_LEVELS:
        problems.append(
            "trust, when present, must be one of "
            + ", ".join(RESOURCE_ASSERTION_TRUST_LEVELS)
        )
    confidence = value.get("confidence")
    if confidence is not None and (
        isinstance(confidence, bool)
        or not isinstance(confidence, (int, float))
        or not (0.0 <= float(confidence) <= 1.0)
    ):
        problems.append("confidence, when present, must be a number in [0, 1]")
    for ts_field in ("asserted_at", "valid_until"):
        ts = value.get(ts_field)
        if ts is not None and (not isinstance(ts, str) or not _is_iso8601(ts)):
            problems.append(f"{ts_field}, when present, must be an ISO-8601 timestamp")
    assertion_id = value.get("assertion_id")
    if assertion_id is not None and (
        not isinstance(assertion_id, str) or not assertion_id
    ):
        problems.append("assertion_id, when present, must be a non-empty string")
    content_hash = value.get("content_hash")
    if content_hash is not None and (
        not isinstance(content_hash, str) or not _SHA256_PREFIXED.match(content_hash)
    ):
        problems.append("content_hash, when present, must match sha256:<64 hex chars>")
    return problems


@dataclass(frozen=True)
class ResourceClassificationAssertion:
    """A trusted, provenance-bearing classification assertion about a resource.

    The unit AtlaSent *consumes* from an external data-security classifier
    (e.g. Inspect Data) — it does not produce classifications itself (ADR-041).
    Attach the ``as_dict()`` form under the ``resource`` namespace of a context
    envelope; AtlaSent consumes it alongside identity, approvals, policy, and
    runtime context to make — and prove — the authorization decision::

        env = {
            "resource": {
                "kind": "customer_record",
                "ref": "crm:account:A_1",
                "assertions": [
                    ResourceClassificationAssertion(
                        classification="phi",
                        source="partner:inspect-data",
                        trust="partner_attested",
                        confidence=0.98,
                    ).as_dict()
                ],
            }
        }

    Only ``classification`` and ``source`` are required. Policy MUST NOT treat
    an assertion as fact without checking ``trust`` / freshness.
    """

    classification: str
    source: str
    trust: str | None = None
    confidence: float | None = None
    asserted_at: str | None = None
    valid_until: str | None = None
    assertion_id: str | None = None
    content_hash: str | None = None

    def validate(self) -> list[str]:
        """Return a list of problems; an empty list means well-formed."""
        return validate_resource_classification_assertion(self.as_dict())

    def as_dict(self) -> dict[str, Any]:
        """Serialize to the wire dict, omitting unset optional fields."""
        out: dict[str, Any] = {
            "classification": self.classification,
            "source": self.source,
        }
        if self.trust is not None:
            out["trust"] = self.trust
        if self.confidence is not None:
            out["confidence"] = self.confidence
        if self.asserted_at is not None:
            out["asserted_at"] = self.asserted_at
        if self.valid_until is not None:
            out["valid_until"] = self.valid_until
        if self.assertion_id is not None:
            out["assertion_id"] = self.assertion_id
        if self.content_hash is not None:
            out["content_hash"] = self.content_hash
        return out


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
