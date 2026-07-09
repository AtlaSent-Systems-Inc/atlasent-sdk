"""Clinical trial blinding/unblinding wire types.

Parity with ``typescript/src/clinical.ts``.

Wire surface: ``v1-clinical-unblind`` edge function (atlasent-api).
Operations: ``list`` (GET), ``get`` (GET ?trial_id=X), ``history``
(GET /history), ``blind`` (POST /blind), ``unblind`` (POST /unblind),
``emergency`` (POST /emergency).

Supports ICH E6(R2) §4.8 / 21 CFR Part 11 §11.10(a) / §11.50 / §11.300
execution-time authorization of clinical trial unblinding operations.
The blinding state machine is append-only; each transition produces an
immutable :class:`ClinicalUnblindingEvent` in the audit ledger.

Wire-stable as ``clinical.v1``.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Literals
# ---------------------------------------------------------------------------

ClinicalBlindingStatus = Literal[
    "blinded",
    "unblinding_in_progress",
    "unblinded",
    "emergency_unblinded",
    "suspended",
]
"""Status values matching the DB CHECK on ``clinical_trial_blinds.status``."""

ClinicalUnblindingEventType = Literal[
    "blind_established",
    "unblinding_initiated",
    "unblinding_executed",
    "emergency_unblinding_executed",
    "blinding_reinstated",
    "suspended",
    "reinstated",
]
"""Event types recorded in the append-only ``clinical_unblinding_events`` ledger."""

# Terminal states in which the randomized assignment is (fully or partially) revealed.
_UNBLINDED_STATES: frozenset[str] = frozenset({"unblinded", "emergency_unblinded"})


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class ClinicalTrialBlind(BaseModel):
    """A clinical trial blinding record.

    Returned by ``GET`` (list) and ``GET ?trial_id=X``. The lifecycle is a
    state machine — ``blinded → unblinding_in_progress | emergency_unblinded
    | suspended → unblinded`` — enforced server-side by a BEFORE UPDATE
    trigger; illegal transitions are rejected.
    """

    id: str
    org_id: str
    trial_id: str
    trial_name: str
    protocol_number: str | None = None
    phase: str | None = None
    blinding_type: str
    status: ClinicalBlindingStatus
    established_by: str
    established_evaluation_id: str | None = None
    sponsor_org: str | None = None
    randomization_code_hash: str
    """SHA-256 hex of the randomization code. Never the code itself."""
    created_at: str
    unblinded_by: str | None = None
    unblinded_at: str | None = None
    unblinding_evaluation_id: str | None = None
    emergency_unblinded_by: str | None = None
    emergency_unblinded_at: str | None = None
    suspended_at: str | None = None
    suspended_by: str | None = None

    model_config = {"extra": "allow"}


class ClinicalUnblindingEvent(BaseModel):
    """A single audit event from the clinical unblinding ledger.

    Returned by ``GET /history``. Append-only — a correction is a new event,
    never a mutation of an existing one (§11.10(a) complete records).
    """

    id: str
    org_id: str
    trial_id: str
    blind_id: str
    event_type: ClinicalUnblindingEventType
    actor_id: str
    evaluation_id: str | None = None
    permit_token_hash: str | None = None
    reason: str
    approval_meaning: str | None = None
    """§11.50(a)(2) electronic signature meaning text."""
    subject_ids: list[str] | None = None
    emergency: bool = False
    unblinding_scope: str
    occurred_at: str
    metadata: dict[str, object] | None = None

    model_config = {"extra": "allow"}


class ClinicalBlindRequest(BaseModel):
    """``POST /blind`` — establish a new blinding record for a clinical trial."""

    trial_id: str
    trial_name: str
    phase: str
    blinding_type: str
    randomization_code_hash: str
    """SHA-256 hex hash of the randomization code. Never the code itself."""
    established_by: str
    reason: str
    protocol_number: str | None = None
    evaluation_id: str | None = None
    approval_meaning: str | None = None
    """§11.50(a)(2) electronic signature meaning."""
    sponsor_org: str | None = None

    model_config = {"extra": "allow"}


class ClinicalBlindResponse(BaseModel):
    """``POST /blind`` response."""

    blind: ClinicalTrialBlind

    model_config = {"extra": "allow"}


class ClinicalUnblindRequest(BaseModel):
    """``POST /unblind`` — planned (non-emergency) unblinding of a trial.

    Server requires ``approval_meaning`` ≥ 20 characters (§11.50(a)(2)).
    """

    trial_id: str
    actor_id: str
    reason: str
    approval_meaning: str
    """§11.50(a)(2) electronic signature meaning; server requires ≥ 20 chars."""
    evaluation_id: str | None = None
    permit_token_hash: str | None = None
    unblinding_scope: str | None = None
    """Scope of unblinding (e.g. ``"full"``, ``"partial"``, ``"individual"``)."""
    dsmb_authorization_ref: str | None = None
    """DSMB authorization reference for the audit trail."""

    model_config = {"extra": "allow"}


class ClinicalEmergencyRequest(BaseModel):
    """``POST /emergency`` — ICH E6(R2) §4.8 individual-patient emergency unblinding."""

    trial_id: str
    actor_id: str
    subject_id: str
    emergency_justification: str
    evaluation_id: str | None = None
    permit_token_hash: str | None = None
    approval_meaning: str | None = None
    """§11.50(a)(2) electronic signature meaning."""

    model_config = {"extra": "allow"}


class ClinicalMutationResponse(BaseModel):
    """Response body for ``POST /unblind`` and ``POST /emergency``."""

    success: bool
    trial_id: str
    status: ClinicalBlindingStatus | None = None
    subject_id: str | None = None
    """Present on emergency unblinding — the affected subject identifier."""
    event_type: str | None = None
    unblinded_by: str | None = None
    unblinded_at: str | None = None
    occurred_at: str | None = None
    evaluation_id: str | None = None

    model_config = {"extra": "allow"}


class ClinicalTrialListResponse(BaseModel):
    """``GET`` (list) response."""

    trials: list[ClinicalTrialBlind]

    model_config = {"extra": "allow"}


class ClinicalTrialGetResponse(BaseModel):
    """``GET ?trial_id=X`` response."""

    trial: ClinicalTrialBlind

    model_config = {"extra": "allow"}


class ClinicalHistoryResponse(BaseModel):
    """``GET /history`` response."""

    events: list[ClinicalUnblindingEvent]

    model_config = {"extra": "allow"}


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def is_unblinded(status: ClinicalBlindingStatus) -> bool:
    """Return ``True`` when the trial's randomized assignment has been revealed.

    Both planned (``unblinded``) and emergency (``emergency_unblinded``)
    terminal states count as unblinded. ``blinded``,
    ``unblinding_in_progress`` and ``suspended`` are still blinded.
    """
    return status in _UNBLINDED_STATES


def latest_unblinding_event(
    events: list[ClinicalUnblindingEvent],
) -> ClinicalUnblindingEvent | None:
    """Return the most recent event by ``occurred_at``, or ``None`` if empty.

    Ties resolve to the last element in the supplied order (the ledger is
    already returned newest-or-oldest first by the server; this helper does
    not assume a particular order).
    """
    if not events:
        return None
    return max(events, key=lambda e: e.occurred_at)
