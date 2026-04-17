from __future__ import annotations

import functools
import os
from typing import Any, Callable, TypeVar

from .async_client import AsyncAtlaSentClient
from .client import AtlaSentClient

F = TypeVar("F", bound=Callable[..., Any])


def atlasent_guard(
    action: str,
    agent: str | None = None,
    context_factory: Callable[..., dict[str, Any]] | None = None,
    on_deny: str = "raise",
) -> Callable[[F], F]:
    """Decorator that authorizes before calling the wrapped sync function."""

    def decorator(fn: F) -> F:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            from . import _get_client  # avoid circular at import time

            _agent = agent or os.environ.get("ATLASENT_AGENT_ID", fn.__name__)
            ctx = context_factory(*args, **kwargs) if context_factory else {}
            client = _get_client()
            client.authorize(agent=_agent, action=action, context=ctx)
            return fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator


def async_atlasent_guard(
    action: str,
    agent: str | None = None,
    context_factory: Callable[..., dict[str, Any]] | None = None,
    on_deny: str = "raise",
) -> Callable[[F], F]:
    """Decorator that authorizes before calling the wrapped async function."""

    def decorator(fn: F) -> F:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            from . import _get_async_client  # avoid circular at import time

            _agent = agent or os.environ.get("ATLASENT_AGENT_ID", fn.__name__)
            ctx = context_factory(*args, **kwargs) if context_factory else {}
            client = _get_async_client()
            await client.authorize(agent=_agent, action=action, context=ctx)
            return await fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator
