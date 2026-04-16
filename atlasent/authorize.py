"""Top-level convenience function for authorization."""

from typing import Any, Optional

from .client import AtlaSentClient
from .config import get_api_key, get_base_url, get_environment
from .models import AuthorizationResult


def authorize(
    agent: str,
    action: str,
    context: Optional[dict[str, Any]] = None,
    client: Optional[AtlaSentClient] = None,
) -> AuthorizationResult:
    """Evaluate whether an agent action is authorized.

    This is the primary entry point for the AtlaSent SDK. It uses the
    global configuration unless an explicit client is provided.

    Args:
        agent: Identifier of the AI agent requesting authorization.
        action: The action the agent wants to perform.
        context: Optional dictionary of additional context for the
            authorization decision.
        client: An optional AtlaSentClient instance. If not provided,
            a client is created from the global configuration.

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
        client = AtlaSentClient(
            api_key=get_api_key(),
            environment=get_environment(),
            base_url=get_base_url(),
        )
    return client.evaluate(agent, action, context)
