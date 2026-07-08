"""GxP clinical trial action protect wrappers.

Covers three trial integrity action types governed by ICH E6(R2) §4.8 / §5.13
and 21 CFR Part 11 §11.10 / §11.300:

- ``trial.blinding.setup``   — high risk; requires human approval + state snapshot
- ``trial.unblinding.execute`` — critical; requires verified actor + human approval
- ``trial.unblinding.emergency`` — critical; requires MFA + verified actor (patient safety)

All three are machine_executable=False. Unblinding actions always use HITL
escalation; the server-side resolver handles quorum and assignment.
Emergency unblinding bypasses the standard quorum flow in favour of a
single treating-physician assertion but retains full audit evidence.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from atlasent.authorize import protect
from atlasent.exceptions import AtlaSentDeniedError
from atlasent.models import Permit

TrialBlindingActionType = Literal["trial.blinding.setup"]
TrialUnblindingActionType = Literal[
    "trial.unblinding.execute",
    "trial.unblinding.emergency",
]
TrialActionType = TrialBlindingActionType | TrialUnblindingActionType

_TRIAL_RISK: dict[str, str] = {
    "trial.blinding.setup": "high",
    "trial.unblinding.execute": "critical",
    "trial.unblinding.emergency": "critical",
}

# Emergency unblinding uses a single-authority path (treating physician)
# rather than a standard quorum — patient safety overrides.
_EMERGENCY_UNBLINDING_ACTIONS: frozenset[str] = frozenset(
    {"trial.unblinding.emergency"}
)


@dataclass
class TrialPermitEvidence:
    """Evidence emitted when a clinical trial action is permitted."""

    action: TrialActionType
    trial_id: str
    authorized_by: str
    permit_token: str
    timestamp: str
    context: dict[str, Any] = field(default_factory=dict)


@dataclass
class TrialDenialEvidence:
    """Evidence emitted when a clinical trial action is denied."""

    action: TrialActionType
    trial_id: str
    authorized_by: str
    denial_reason: str
    timestamp: str
    evaluation_id: str | None = None
    context: dict[str, Any] = field(default_factory=dict)


def protect_trial_action(
    action: TrialActionType,
    trial_id: str,
    authorized_by: str,
    *,
    on_permit_evidence: Callable[[TrialPermitEvidence], None] | None = None,
    on_denial_evidence: Callable[[TrialDenialEvidence], None] | None = None,
    **kwargs: Any,
) -> Permit:
    """Generic clinical trial action protect wrapper.

    Args:
        action: One of the ``TrialActionType`` literals.
        trial_id: The clinical trial identifier.
        authorized_by: Agent or human ID authorising the action.
        on_permit_evidence: Optional callback called with
            :class:`TrialPermitEvidence` when the gate permits the action.
        on_denial_evidence: Optional callback called with
            :class:`TrialDenialEvidence` when
            :class:`atlasent.AtlaSentDeniedError` is raised.
        **kwargs: Action-specific fields:

            For ``trial.blinding.setup``:
                - ``randomization_list_hash`` (str, required): SHA-256 of
                  the sealed randomization list — captured as the state snapshot.
                - ``blinding_administrator`` (str, required): Designated
                  blinding administrator identity (ICH E6(R2) §5.13).

            For ``trial.unblinding.execute``:
                - ``unblinding_authority`` (str, required): Identity of the
                  sponsor unblinding authority.
                - ``unblinding_reason`` (str, required): Documented reason
                  (e.g. interim analysis, regulatory request).
                - ``data_integrity_check`` (str, required): Identifier of
                  the completed data integrity verification run.

            For ``trial.unblinding.emergency``:
                - ``patient_id`` (str, required): Patient receiving emergency
                  unblinding (pseudonymised at rest).
                - ``treating_physician_id`` (str, required): Verified identity
                  of the treating physician requesting unblinding.
                - ``emergency_reason`` (str, required): Clinical justification
                  per ICH E6(R2) §4.8 emergency unblinding provision.

    Raises:
        ValueError: If required action-specific fields are missing.
        atlasent.AtlaSentDeniedError: If the gate denies or holds the action.
    """
    if action == "trial.blinding.setup":
        if not kwargs.get("randomization_list_hash"):
            raise ValueError(
                "trial.blinding.setup requires 'randomization_list_hash'"
            )
        if not kwargs.get("blinding_administrator"):
            raise ValueError(
                "trial.blinding.setup requires 'blinding_administrator'"
            )

    if action == "trial.unblinding.execute":
        if not kwargs.get("unblinding_authority"):
            raise ValueError(
                "trial.unblinding.execute requires 'unblinding_authority'"
            )
        if not kwargs.get("unblinding_reason"):
            raise ValueError(
                "trial.unblinding.execute requires 'unblinding_reason'"
            )
        if not kwargs.get("data_integrity_check"):
            raise ValueError(
                "trial.unblinding.execute requires 'data_integrity_check'"
            )

    if action == "trial.unblinding.emergency":
        if not kwargs.get("patient_id"):
            raise ValueError(
                "trial.unblinding.emergency requires 'patient_id'"
            )
        if not kwargs.get("treating_physician_id"):
            raise ValueError(
                "trial.unblinding.emergency requires 'treating_physician_id'"
            )
        if not kwargs.get("emergency_reason"):
            raise ValueError(
                "trial.unblinding.emergency requires 'emergency_reason'"
            )

    risk_level = _TRIAL_RISK[action]
    is_emergency = action in _EMERGENCY_UNBLINDING_ACTIONS

    context: dict[str, Any] = {
        "machine_executable": False,
        "risk_level": risk_level,
        "trial_id": trial_id,
        "trial_action": action,
    }

    # Blinding setup: capture randomization list hash as the state snapshot
    if action == "trial.blinding.setup":
        context["randomization_list_hash"] = kwargs["randomization_list_hash"]
        context["blinding_administrator"] = kwargs["blinding_administrator"]
        context["hitl_escalation"] = {
            "assigned_to_role": kwargs.get(
                "assigned_to_role", "sponsor-blinding-administrator"
            ),
            "quorum_required": "single_approver",
            "wait_ms": kwargs.get("wait_ms", 86_400_000),  # 24 h default
        }

    # Standard unblinding: requires quorum approval + data integrity check
    if action == "trial.unblinding.execute":
        context["unblinding_authority"] = kwargs["unblinding_authority"]
        context["unblinding_reason"] = kwargs["unblinding_reason"]
        context["data_integrity_check"] = kwargs["data_integrity_check"]
        context["hitl_escalation"] = {
            "assigned_to_role": kwargs.get(
                "assigned_to_role", "sponsor-unblinding-authority"
            ),
            "quorum_required": "simple_majority",
            "wait_ms": kwargs.get("wait_ms", 3_600_000),  # 1 h default
        }

    # Emergency unblinding: treating-physician single-authority path
    if is_emergency:
        context["patient_id"] = kwargs["patient_id"]
        context["treating_physician_id"] = kwargs["treating_physician_id"]
        context["emergency_reason"] = kwargs["emergency_reason"]
        # Emergency path: single treating physician — no quorum wait
        context["hitl_escalation"] = {
            "assigned_to_role": kwargs.get(
                "assigned_to_role", "treating-physician"
            ),
            "quorum_required": "single_approver",
            # No wait — patient safety requires immediate permit
            "wait_ms": kwargs.get("wait_ms", 0),
        }

    import datetime  # local import to avoid loading at module level

    try:
        permit = protect(agent=authorized_by, action=action, context=context)
    except AtlaSentDeniedError as exc:
        if on_denial_evidence is not None:
            on_denial_evidence(
                TrialDenialEvidence(
                    action=action,
                    trial_id=trial_id,
                    authorized_by=authorized_by,
                    denial_reason=str(exc),
                    timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    evaluation_id=getattr(exc, "evaluation_id", None),
                    context=context,
                )
            )
        raise

    if on_permit_evidence is not None:
        on_permit_evidence(
            TrialPermitEvidence(
                action=action,
                trial_id=trial_id,
                authorized_by=authorized_by,
                permit_token=getattr(permit, "permit_token", ""),
                timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                context=context,
            )
        )

    return permit


def protect_trial_blinding_setup(
    trial_id: str,
    authorized_by: str,
    randomization_list_hash: str,
    blinding_administrator: str,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``trial.blinding.setup``.

    Args:
        trial_id: Clinical trial identifier.
        authorized_by: Authorising agent or human ID.
        randomization_list_hash: SHA-256 of the sealed randomization list.
        blinding_administrator: Designated blinding administrator identity.
        **kwargs: Optional overrides (``assigned_to_role``, ``wait_ms``,
            evidence callbacks ``on_permit_evidence``, ``on_denial_evidence``).
    """
    return protect_trial_action(
        "trial.blinding.setup",
        trial_id,
        authorized_by,
        randomization_list_hash=randomization_list_hash,
        blinding_administrator=blinding_administrator,
        **kwargs,
    )


def protect_trial_unblinding_execute(
    trial_id: str,
    authorized_by: str,
    unblinding_authority: str,
    unblinding_reason: str,
    data_integrity_check: str,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``trial.unblinding.execute``.

    Args:
        trial_id: Clinical trial identifier.
        authorized_by: Authorising agent or human ID.
        unblinding_authority: Sponsor unblinding authority identity.
        unblinding_reason: Documented reason for unblinding.
        data_integrity_check: Identifier of the completed data integrity run.
        **kwargs: Optional overrides (``assigned_to_role``, ``wait_ms``,
            evidence callbacks).
    """
    return protect_trial_action(
        "trial.unblinding.execute",
        trial_id,
        authorized_by,
        unblinding_authority=unblinding_authority,
        unblinding_reason=unblinding_reason,
        data_integrity_check=data_integrity_check,
        **kwargs,
    )


def protect_trial_unblinding_emergency(
    trial_id: str,
    authorized_by: str,
    patient_id: str,
    treating_physician_id: str,
    emergency_reason: str,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``trial.unblinding.emergency``.

    Patient-safety emergency unblinding. Requires MFA-verified treating
    physician identity (21 CFR Part 11 §11.300). No quorum wait.

    Args:
        trial_id: Clinical trial identifier.
        authorized_by: Authorising agent or human ID.
        patient_id: Pseudonymised patient identifier.
        treating_physician_id: Verified identity of the treating physician.
        emergency_reason: Clinical justification for emergency unblinding.
        **kwargs: Optional overrides (``assigned_to_role``, evidence callbacks).
    """
    return protect_trial_action(
        "trial.unblinding.emergency",
        trial_id,
        authorized_by,
        patient_id=patient_id,
        treating_physician_id=treating_physician_id,
        emergency_reason=emergency_reason,
        **kwargs,
    )
