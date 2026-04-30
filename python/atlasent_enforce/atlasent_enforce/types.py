from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Generic, Literal, Protocol, TypeVar

T = TypeVar("T")

Decision = Literal["allow", "deny", "hold", "escalate"]

ReasonCode = Literal[
    "evaluate_client_error",
    "evaluate_unavailable",
    "verify_client_error",
    "verify_unavailable",
    "verify_latency_breach",
    "binding_mismatch",
    "permit_expired",
    "permit_consumed",
    "permit_revoked",
    "permit_not_found",
    "permit_tampered",
]

PermitOutcomeReasonCode = Literal[
    "permit_expired",
    "permit_consumed",
    "permit_revoked",
    "permit_not_found",
]
"""Subset of :data:`ReasonCode` values aligned with the v1 SDK's
``PermitOutcome`` (atlasent-sdk PR #132). When a verify-permit adapter
raises an error carrying ``reason_code`` set to one of these,
``Enforce.run()`` surfaces it verbatim — byte-identical with the v1
SDK's typed ``outcome`` field.

See ``contract/ENFORCE_PACK.md`` § "Decision matrix" for the full
mapping; ``atlasent/docs/REVOCATION_RUNBOOK.md`` for the operator-
facing matrix this discriminator drives.
"""


@dataclass(frozen=True, slots=True)
class Bindings:
    org_id: str
    actor_id: str
    action_type: str


@dataclass(frozen=True, slots=True)
class VerifiedPermit:
    token: str
    org_id: str
    actor_id: str
    action_type: str
    expires_at: str


@dataclass(frozen=True, slots=True)
class EvaluateResponse:
    decision: Decision
    permit_token: str | None = None
    permit_expires_at: str | None = None
    reason_code: str | None = None


class EnforceCompatibleClient(Protocol):
    async def evaluate(self, request: dict[str, Any]) -> EvaluateResponse: ...
    async def verify_permit(self, token: str) -> VerifiedPermit: ...


@dataclass(frozen=True, slots=True)
class RunRequest(Generic[T]):
    request: dict[str, Any]
    execute: Callable[[VerifiedPermit], Awaitable[T]]


@dataclass(frozen=True, slots=True)
class RunResult(Generic[T]):
    decision: Decision
    value: T | None = None
    permit: VerifiedPermit | None = None
    reason_code: str | None = None
