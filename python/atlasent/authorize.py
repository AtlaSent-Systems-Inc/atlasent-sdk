"""Top-level convenience functions using global configuration."""

from __future__ import annotations

import logging
from typing import Any

from .client import AtlaSentClient
from .config import get_anon_key, get_api_key, get_base_url
from .models import (
    AuthorizationResult,
    EvaluateResult,
    GateResult,
    Permit,
    VerifyResult,
)

logger = logging.getLogger("atlasent")

_default_client: AtlaSentClient | None = None


def _get_default_client() -> AtlaSentClient:
    """Return a lazily-created singleton client for connection pooling."""
    global _default_client  # noqa: PLW0603
    if _default_client is None:
        logger.debug("Creating default AtlaSentClient singleton")
        _default_client = AtlaSentClient(
            api_key=get_api_key(),
            anon_key=get_anon_key(),
            base_url=get_base_url(),
        )
    return _default_client


def _reset_default_client() -> None:
    """Close and discard the cached default client.  For testing."""
    global _default_client  # noqa: PLW0603
    if _default_client is not None:
        _default_client.close()
        _default_client = None


def evaluate(
    action_type: str,
    actor_id: str,
    context: dict[str, Any] | None = None,
) -> EvaluateResult:
    """Evaluate an action using the globally configured client.

    Shortcut for ``AtlaSentClient.evaluate``.  Requires a prior call
    to :func:`atlasent.configure` or the ``ATLASENT_API_KEY`` env var.
    """
    return _get_default_client().evaluate(action_type, actor_id, context)


def verify(
    permit_token: str,
    action_type: str = "",
    actor_id: str = "",
    context: dict[str, Any] | None = None,
) -> VerifyResult:
    """Verify a permit token using the globally configured client."""
    return _get_default_client().verify(permit_token, action_type, actor_id, context)


def gate(
    action_type: str,
    actor_id: str,
    context: dict[str, Any] | None = None,
) -> GateResult:
    """Evaluate then verify using the globally configured client."""
    return _get_default_client().gate(action_type, actor_id, context)


def protect(
    *,
    agent: str,
    action: str,
    context: dict[str, Any] | None = None,
) -> Permit:
    """Authorize an action end-to-end — the category primitive.

    Top-level shortcut for :meth:`AtlaSentClient.protect`, using the
    globally configured client. On allow, returns a verified
    :class:`~atlasent.models.Permit`. On policy denial or permit
    verification failure, raises
    :class:`~atlasent.exceptions.AtlaSentDeniedError`. On transport /
    auth / rate-limit / server error, raises
    :class:`~atlasent.exceptions.AtlaSentError`.

    This is the **fail-closed boundary**: there is no
    ``permitted=False`` return path. If ``protect()`` returns, the
    action is authorized; if it raises, the action must not proceed.

    Matches the TypeScript SDK's ``atlasent.protect()``.

    Example::

        from atlasent import protect, AtlaSentDeniedError, AtlaSentError

        try:
            permit = protect(
                agent="deploy-bot",
                action="deploy_to_production",
                context={"commit": commit, "approver": approver},
            )
        except AtlaSentDeniedError as exc:
            # Policy said no (or the permit failed verification).
            log.warning("Denied: %s (evaluation_id=%s)",
                        exc.reason, exc.evaluation_id)
            return
        except AtlaSentError:
            # Transport / auth / server failure. Fail-closed.
            raise

        run_deploy(commit)
    """
    return _get_default_client().protect(agent=agent, action=action, context=context)


def authorize(
    *,
    agent: str,
    action: str,
    context: dict[str, Any] | None = None,
    verify: bool = True,
    raise_on_deny: bool = False,
) -> AuthorizationResult:
    """Authorize an agent action — the one-call public SDK entrypoint.

    Stripe-style convenience wrapper that uses the globally configured
    client (see :func:`atlasent.configure` or ``ATLASENT_API_KEY``).

    Example::

        from atlasent import authorize

        result = authorize(
            agent="clinical-data-agent",
            action="modify_patient_record",
            context={"user": "dr_smith", "environment": "production"},
        )
        if result.permitted:
            # execute action
            ...
        else:
            logger.warning("Denied: %s", result.reason)

    Args:
        agent: Identifier of the calling agent.
        action: The action being authorized.
        context: Arbitrary policy context.
        verify: If ``True`` (default), verify the permit end-to-end.
        raise_on_deny: Raise :class:`PermissionDeniedError` on denial
            instead of returning ``permitted=False``.

    Returns:
        :class:`AuthorizationResult`.
    """
    return _get_default_client().authorize(
        agent=agent,
        action=action,
        context=context,
        verify=verify,
        raise_on_deny=raise_on_deny,
    )
