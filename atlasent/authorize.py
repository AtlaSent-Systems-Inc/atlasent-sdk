"""Top-level convenience function for authorization."""

import logging
from typing import Any, Optional

from .client import AtlaSentClient
from .config import get_api_key, get_base_url, get_environment
from .models import AuthorizationResult

logger = logging.getLogger("atlasent")

_default_client: AtlaSentClient | None = None


def _get_default_client() -> AtlaSentClient:
    """Return a lazily-created module-level client for connection pooling."""
    global _default_client
    if _default_client is None:
        logger.debug("Creating default AtlaSentClient singleton")
        _default_client = AtlaSentClient(
            api_key=get_api_key(),
            environment=get_environment(),
            base_url=get_base_url(),
        )
    return _default_client


def _reset_default_client() -> None:
    """Close and discard the cached default client. Useful for testing."""
    global _default_client
    if _default_client is not None:
        _default_client.close()
        _default_client = None


def authorize(
    agent: str,
    action: str,
    context: Optional[dict[str, Any]] = None,
    client: Optional[AtlaSentClient] = None,
) -> AuthorizationResult:
    """Evaluate whether an agent action is authorized.

    This is the primary entry point for the AtlaSent SDK. It uses the
    global configuration unless an explicit client is provided.

    When called without an explicit client, a module-level singleton is
    reused across calls for efficient connection pooling.

    Args:
        agent: Identifier of the AI agent requesting authorization.
        action: The action the agent wants to perform.
        context: Optional dictionary of additional context for the
            authorization decision.
        client: An optional AtlaSentClient instance. If not provided,
            a cached client is created from the global configuration.

    Returns:
        An AuthorizationResult indicating whether the action is permitted.

    Example::

        import atlasent

        atlasent.configure(api_key="ask_live_...")

        result = atlasent.authorize(
            agent="clinical-data-agent",
            action="update_patient_record",
            context={"patient_id": "PT-2024-001"},
        )
        if result:
            print("Action permitted")
    """
    if client is None:
        client = _get_default_client()
    return client.evaluate(agent, action, context)
