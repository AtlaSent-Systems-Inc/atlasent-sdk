"""``atlasent-v2-preview`` — PREVIEW.

DO NOT USE IN PRODUCTION. Exports here are subject to change
without semver discipline until v2 GA. See ``./README.md``.
"""

from __future__ import annotations

from .canonicalize import canonicalize_payload
from .decision_event import (
    KNOWN_DECISION_EVENT_TYPES,
    ConsumedEvent,
    ConsumedPayload,
    DecisionEvent,
    EscalatedEvent,
    EscalatedPayload,
    HoldResolvedEvent,
    HoldResolvedPayload,
    PermitIssuedEvent,
    PermitIssuedPayload,
    RateLimitStateEvent,
    RateLimitStatePayload,
    RevokedEvent,
    RevokedPayload,
    UnknownDecisionEvent,
    VerifiedEvent,
    VerifiedPayload,
    build_decision_event,
)
from .hash import hash_payload
from .parse_sse import parse_decision_event_stream
from .types import (
    ConsumeExecutionStatus,
    ConsumeRequest,
    ConsumeResponse,
    Proof,
    ProofCheckName,
    ProofDecision,
    ProofExecutionStatus,
    ProofFailureReason,
    ProofVerificationCheck,
    ProofVerificationResult,
    ProofVerificationStatus,
)

__version__ = "2.0.0a0"

__all__ = [
    "__version__",
    "canonicalize_payload",
    "hash_payload",
    "parse_decision_event_stream",
    "build_decision_event",
    "ConsumeExecutionStatus",
    "ConsumeRequest",
    "ConsumeResponse",
    "Proof",
    "ProofCheckName",
    "ProofDecision",
    "ProofExecutionStatus",
    "ProofFailureReason",
    "ProofVerificationCheck",
    "ProofVerificationResult",
    "ProofVerificationStatus",
    "KNOWN_DECISION_EVENT_TYPES",
    "DecisionEvent",
    "ConsumedEvent",
    "ConsumedPayload",
    "EscalatedEvent",
    "EscalatedPayload",
    "HoldResolvedEvent",
    "HoldResolvedPayload",
    "PermitIssuedEvent",
    "PermitIssuedPayload",
    "RateLimitStateEvent",
    "RateLimitStatePayload",
    "RevokedEvent",
    "RevokedPayload",
    "UnknownDecisionEvent",
    "VerifiedEvent",
    "VerifiedPayload",
]
