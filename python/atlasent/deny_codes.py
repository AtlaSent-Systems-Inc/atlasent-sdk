"""Stable deny-code constants and helpers.

The AtlaSent API returns a ``deny_code`` — a stable, UPPER_SNAKE machine
string naming *why* a non-allow decision was reached (e.g.
``"SNAPSHOT_REQUIRED"``). The wire field is an open string (new codes can
appear without an SDK release), so this module is a *convenience* registry of
the codes documented today plus predicates for the ones callers commonly
branch on. Treat unknown codes as a generic deny — never assume this list is
exhaustive.

Branch on ``deny_code`` (here / on :class:`~atlasent.exceptions.AtlaSentDenied`),
never on the human-readable ``reason``.
"""

from __future__ import annotations

from typing import Final

__all__ = ["DenyCode", "requires_human_approval"]


class DenyCode:
    """Known ``deny_code`` values. Not exhaustive — the wire field is open."""

    UNKNOWN_PROTECTED_ACTION: Final = "UNKNOWN_PROTECTED_ACTION"
    ENVIRONMENT_MISMATCH: Final = "ENVIRONMENT_MISMATCH"
    NO_AUTHORITY: Final = "NO_AUTHORITY"
    NO_SNAPSHOT: Final = "NO_SNAPSHOT"
    SNAPSHOT_TAMPERED: Final = "SNAPSHOT_TAMPERED"
    SNAPSHOT_REQUIRED: Final = "SNAPSHOT_REQUIRED"
    DEPENDENCY_NOT_SATISFIED: Final = "DEPENDENCY_NOT_SATISFIED"
    SIGNAL_UNTRUSTED: Final = "SIGNAL_UNTRUSTED"
    LATENCY_BUDGET_EXCEEDED: Final = "LATENCY_BUDGET_EXCEEDED"
    HARD_CONSTRAINT_VIOLATED: Final = "HARD_CONSTRAINT_VIOLATED"
    INTENT_MISMATCH: Final = "INTENT_MISMATCH"
    PRESSURE_THRESHOLD_EXCEEDED: Final = "PRESSURE_THRESHOLD_EXCEEDED"
    BOUNDARY_VIOLATION: Final = "BOUNDARY_VIOLATION"
    PERMIT_UNBOUND_EXECUTION: Final = "PERMIT_UNBOUND_EXECUTION"
    EXECUTION_PAYLOAD_HASH_REQUIRED: Final = "EXECUTION_PAYLOAD_HASH_REQUIRED"
    #: Fewer verified human approvals than policy requires. Emitted (among
    #: other cases) by the per-class human-in-the-loop gate
    #: (``requires_human_approval=true`` reached without a verified approval).
    #: A human must approve; route the action to an approval queue and
    #: re-evaluate. ``retry_advice`` is ``after_human_approval``.
    INSUFFICIENT_APPROVALS: Final = "INSUFFICIENT_APPROVALS"


def requires_human_approval(deny_code: str | None) -> bool:
    """True when ``deny_code`` indicates a human approval is required.

    Recognizes :attr:`DenyCode.INSUFFICIENT_APPROVALS`. Useful to route a
    denied action into an approval queue rather than treating it as a hard
    refusal::

        try:
            client.protect(action_type="agent.bulk_delete", actor_id=agent_id)
        except AtlaSentDenied as exc:
            if exc.is_human_approval_required:
                queue_for_human_review(...)
            else:
                raise
    """
    return deny_code == DenyCode.INSUFFICIENT_APPROVALS
