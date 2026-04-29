"""``atlasent.aio`` — async-namespace siblings of the top-level helpers.

Currently exports the async :func:`with_permit`. Expand here as more
top-level shortcuts gain async siblings.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from .async_client import AsyncAtlaSentClient
from .models import Permit

T = TypeVar("T")

AsyncOrSyncFn = Callable[[Permit], Awaitable[T]] | Callable[[Permit], T]


async def with_permit(
    client: AsyncAtlaSentClient,
    *,
    agent: str,
    action: str,
    context: dict[str, Any] | None = None,
    fn: AsyncOrSyncFn[T],
) -> T:
    """Async sibling of :func:`atlasent.with_permit`.

    Takes an :class:`~atlasent.async_client.AsyncAtlaSentClient`
    explicitly — there's no globally-configured async client in v1, so
    the caller manages the lifecycle (typically via ``async with``).

    ``fn`` may be sync or async; if it returns a coroutine, the
    coroutine is awaited.

    Args:
        client: The async client to authorize against.
        agent: Same semantics as
            :meth:`AsyncAtlaSentClient.protect.agent`.
        action: Same semantics as
            :meth:`AsyncAtlaSentClient.protect.action`.
        context: Optional context dict.
        fn: Sync or async callable invoked with the verified permit.

    Returns:
        Whatever ``fn`` returns (awaiting if it's a coroutine).

    Raises:
        AtlaSentDeniedError: Policy denied or permit failed
            verification. ``fn`` is never invoked.
        AtlaSentError: Transport / auth / server error. ``fn`` is
            never invoked.

    Errors raised by ``fn`` propagate untouched.
    """
    permit = await client.protect(agent=agent, action=action, context=context)
    result = fn(permit)
    if inspect.isawaitable(result):
        return await result  # type: ignore[no-any-return]
    return result  # type: ignore[return-value]


__all__ = ["with_permit"]
