"""Top-level convenience functions using global configuration."""

from __future__ import annotations

import logging
from typing import Any

from .client import AtlaSentClient
from .config import get_anon_key, get_api_key, get_base_url
from .models import EvaluateResult, GateResult, VerifyResult

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
