"""Pricing action protect wrappers — Phase 4 vertical.

Pricing rule publishing and discount approval. Machine-executability
and risk level are dynamic based on the magnitude of the change.
"""

from __future__ import annotations

from typing import Any, Literal

from atlasent.authorize import protect
from atlasent.models import Permit

PricingActionType = Literal[
    "pricing.rule.publish",
    "pricing.discount.approve",
]

# Thresholds
_RULE_PUBLISH_AUTO_THRESHOLD = 5.0  # change_pct < 5 → machine_executable
_DISCOUNT_MEDIUM_THRESHOLD = (
    10.0  # discount_pct < 10 → medium risk + machine_executable
)


def protect_pricing_action(
    action: PricingActionType,
    rule_id: str,
    authorized_by: str,
    **kwargs: Any,
) -> Permit:
    """Generic pricing action protect wrapper.

    Risk level and machine-executability are derived dynamically:

    - ``pricing.rule.publish``: machine_executable when ``change_pct`` < 5.0
      (risk=high regardless).
    - ``pricing.discount.approve``: risk=medium + machine_executable when
      ``discount_pct`` < 10.0; risk=high + machine_executable=False otherwise.

    Args:
        action: One of the ``PricingActionType`` literals.
        rule_id: Pricing rule or discount ID.
        authorized_by: Agent or human ID authorising the action.
        **kwargs: Action-specific fields (``change_pct`` for
            ``pricing.rule.publish``; ``discount_pct`` for
            ``pricing.discount.approve``). Optional overrides:
            ``assigned_to_role``, ``wait_ms``.
    """
    if action == "pricing.rule.publish":
        change_pct: float = float(kwargs.get("change_pct", 0.0))
        machine_executable = change_pct < _RULE_PUBLISH_AUTO_THRESHOLD
        risk_level = "high"

        context: dict[str, Any] = {
            "machine_executable": machine_executable,
            "risk_level": risk_level,
            "rule_id": rule_id,
            "pricing_action": action,
            "change_pct": change_pct,
        }

        if not machine_executable:
            context["hitl_escalation"] = {
                "assigned_to_role": kwargs.get("assigned_to_role", "pricing-approver"),
                "quorum_required": kwargs.get("quorum_required", "single_approver"),
                "wait_ms": kwargs.get("wait_ms", 3_600_000),  # 1 h
            }

    elif action == "pricing.discount.approve":
        discount_pct: float = float(kwargs.get("discount_pct", 0.0))
        machine_executable = discount_pct < _DISCOUNT_MEDIUM_THRESHOLD
        risk_level = "medium" if discount_pct < _DISCOUNT_MEDIUM_THRESHOLD else "high"

        context = {
            "machine_executable": machine_executable,
            "risk_level": risk_level,
            "rule_id": rule_id,
            "pricing_action": action,
            "discount_pct": discount_pct,
        }

        if not machine_executable:
            context["hitl_escalation"] = {
                "assigned_to_role": kwargs.get("assigned_to_role", "pricing-approver"),
                "quorum_required": kwargs.get("quorum_required", "single_approver"),
                "wait_ms": kwargs.get("wait_ms", 3_600_000),  # 1 h
            }

    else:
        # Unknown action — fail closed
        context = {
            "machine_executable": False,
            "risk_level": "high",
            "rule_id": rule_id,
            "pricing_action": action,
        }

    return protect(agent=authorized_by, action=action, context=context)


def protect_pricing_rule(
    rule_id: str,
    authorized_by: str,
    change_pct: float,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``pricing.rule.publish``.

    Args:
        rule_id: Pricing rule ID.
        authorized_by: Authorising agent/human ID.
        change_pct: Percentage change in the pricing rule. Values >= 5.0
            trigger human review.
        **kwargs: Optional overrides forwarded to ``protect_pricing_action``.
    """
    return protect_pricing_action(
        "pricing.rule.publish",
        rule_id,
        authorized_by,
        change_pct=change_pct,
        **kwargs,
    )
