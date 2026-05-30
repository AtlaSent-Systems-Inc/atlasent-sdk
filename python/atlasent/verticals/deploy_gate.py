"""Deploy Gate V1 protect wrappers — production deployment authorization."""

from __future__ import annotations

import json
import urllib.request
from typing import Any

from atlasent.authorize import protect
from atlasent.models import Permit

_RISK_LEVEL = "critical"
_MACHINE_EXECUTABLE = False
_FAIL_CLOSED = True
_ASSIGNED_TO_ROLE = "deploy-approver"
_WAIT_MS = 600_000  # 10 minutes


def _notify_slack(
    webhook_url: str,
    *,
    actor: str,
    environment: str,
    reason: str,
) -> None:
    """Post an informational Slack message to the given webhook URL.

    All errors are swallowed so that notification failures never mask the
    original authorization exception.
    """
    try:
        payload = json.dumps(
            {
                "text": (
                    f":no_entry: Deploy denied for *{actor}* targeting"
                    f" `{environment}`: {reason}"
                )
            }
        ).encode()
        req = urllib.request.Request(
            webhook_url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)  # noqa: S310
    except Exception:  # noqa: BLE001
        pass


def protect_deploy(
    actor: str,
    target_id: str | None = None,
    environment: str = "production",
    repository: str | None = None,
    sha: str | None = None,
    notify_slack_webhook: str | None = None,
    **kwargs: Any,
) -> Permit:
    """Authorize a production deployment end-to-end.

    This is the primary Deploy Gate protect wrapper.  It is
    ``machine_executable=False``, ``risk_level="critical"``, and
    ``fail_closed=True``; all deploys require human authorization via
    the ``deploy-approver`` role with a 10-minute HITL wait window.

    If the authorization is denied (or any other exception is raised by
    :func:`atlasent.authorize.protect`) **and** *notify_slack_webhook*
    is set, an informational Slack message is POSTed to that URL before
    the exception is re-raised.  Webhook failures are swallowed so the
    original exception always propagates.

    Args:
        actor: Identity of the entity requesting the deploy
            (e.g. ``"github:alice"``).
        target_id: Optional service name or artifact identifier.
        environment: Deployment environment (default ``"production"``).
        repository: Optional repository reference
            (e.g. ``"myorg/myservice"``).
        sha: Optional commit SHA being deployed.
        notify_slack_webhook: Optional Slack incoming-webhook URL.  When
            set and the deploy is denied, a notification is posted.
        **kwargs: Additional context fields forwarded verbatim.

    Returns:
        A verified :class:`~atlasent.models.Permit` when the deploy is
        authorized.

    Raises:
        :class:`~atlasent.exceptions.AtlaSentDeniedError`: When the
            deploy is denied by policy.
        :class:`~atlasent.exceptions.AtlaSentError`: On transport /
            auth / server failure (fail-closed).
    """
    context: dict[str, Any] = {
        "machine_executable": _MACHINE_EXECUTABLE,
        "risk_level": _RISK_LEVEL,
        "fail_closed": _FAIL_CLOSED,
        "environment": environment,
        "hitl_escalation": {
            "assigned_to_role": _ASSIGNED_TO_ROLE,
            "wait_ms": _WAIT_MS,
        },
    }

    if target_id is not None:
        context["target_id"] = target_id
    if repository is not None:
        context["repository"] = repository
    if sha is not None:
        context["sha"] = sha

    try:
        permit = protect(agent=actor, action="production.deploy", context=context)
        return permit
    except Exception as exc:
        if notify_slack_webhook:
            _notify_slack(
                notify_slack_webhook,
                actor=actor,
                environment=environment,
                reason=str(exc),
            )
        raise


def protect_production_deploy(actor: str, **kwargs: Any) -> Permit:
    """Convenience wrapper for production deployments.

    Equivalent to calling :func:`protect_deploy` with
    ``environment="production"``.

    Args:
        actor: Identity of the entity requesting the deploy.
        **kwargs: All other arguments forwarded to :func:`protect_deploy`.

    Returns:
        A verified :class:`~atlasent.models.Permit` when the deploy is
        authorized.
    """
    return protect_deploy(actor, environment="production", **kwargs)
