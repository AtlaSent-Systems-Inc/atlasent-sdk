"""AtlaSent Python SDK."""

from .client import AtlaSentClient
from .async_client import AsyncAtlaSentClient
from .exceptions import (
    AtlaSentError,
    AtlaSentDeniedError,
    AtlaSentHoldError,
    AtlaSentEscalateError,
    AtlaSentAPIError,
)
from .guard import atlasent_guard, async_atlasent_guard
from .models import AuthorizeResult, Decision

import os as _os

_default_client: AtlaSentClient | None = None
_default_async_client: AsyncAtlaSentClient | None = None


def _get_client() -> AtlaSentClient:
    global _default_client
    if _default_client is None:
        _default_client = AtlaSentClient(
            api_key=_os.environ["ATLASENT_API_KEY"],
            base_url=_os.environ.get("ATLASENT_BASE_URL", "https://api.atlasent.io"),
            timeout=float(_os.environ.get("ATLASENT_TIMEOUT", "10")),
        )
    return _default_client


def _get_async_client() -> AsyncAtlaSentClient:
    global _default_async_client
    if _default_async_client is None:
        _default_async_client = AsyncAtlaSentClient(
            api_key=_os.environ["ATLASENT_API_KEY"],
            base_url=_os.environ.get("ATLASENT_BASE_URL", "https://api.atlasent.io"),
            timeout=float(_os.environ.get("ATLASENT_TIMEOUT", "10")),
        )
    return _default_async_client


def authorize(
    agent: str,
    action: str,
    context: dict | None = None,
    *,
    client: AtlaSentClient | None = None,
) -> AuthorizeResult:
    """Authorize an action synchronously. Raises on deny/hold/escalate."""
    c = client or _get_client()
    return c.authorize(agent=agent, action=action, context=context or {})


async def async_authorize(
    agent: str,
    action: str,
    context: dict | None = None,
    *,
    client: AsyncAtlaSentClient | None = None,
) -> AuthorizeResult:
    """Authorize an action asynchronously. Raises on deny/hold/escalate."""
    c = client or _get_async_client()
    return await c.authorize(agent=agent, action=action, context=context or {})


__all__ = [
    "AtlaSentClient",
    "AsyncAtlaSentClient",
    "AtlaSentError",
    "AtlaSentDeniedError",
    "AtlaSentHoldError",
    "AtlaSentEscalateError",
    "AtlaSentAPIError",
    "atlasent_guard",
    "async_atlasent_guard",
    "AuthorizeResult",
    "Decision",
    "authorize",
    "async_authorize",
]
