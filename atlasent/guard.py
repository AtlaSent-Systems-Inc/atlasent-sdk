"""Decorators and middleware for framework integration.

Provides ``atlasent_guard`` for wrapping sync functions (Flask routes,
Django views) and ``async_atlasent_guard`` for async functions (FastAPI
endpoints, Starlette routes).

Usage with Flask::

    from atlasent import AtlaSentClient
    from atlasent.guard import atlasent_guard

    client = AtlaSentClient(api_key="ask_live_...")

    @app.route("/modify-record", methods=["POST"])
    @atlasent_guard(client, "modify_patient_record", actor_id="flask-agent")
    def modify_record(gate_result=None):
        return {"permit_hash": gate_result.verification.permit_hash}

Usage with FastAPI::

    from atlasent import AsyncAtlaSentClient
    from atlasent.guard import async_atlasent_guard

    client = AsyncAtlaSentClient(api_key="ask_live_...")

    @app.post("/modify-record")
    @async_atlasent_guard(client, "modify_patient_record", actor_id="api-agent")
    async def modify_record(gate_result=None):
        return {"permit_hash": gate_result.verification.permit_hash}
"""

from __future__ import annotations

import functools
import logging
from collections.abc import Callable
from typing import Any

from .async_client import AsyncAtlaSentClient
from .client import AtlaSentClient

logger = logging.getLogger("atlasent")


def atlasent_guard(
    client: AtlaSentClient,
    action_type: str,
    *,
    actor_id: str = "",
    context: dict[str, Any] | None = None,
    actor_id_kwarg: str = "",
    context_kwarg: str = "",
) -> Callable:
    """Decorator that gates a sync function behind AtlaSent authorization.

    Calls ``client.gate()`` before the wrapped function executes.
    On permit, the ``GateResult`` is passed as the ``gate_result``
    keyword argument. On deny, ``AtlaSentDenied`` propagates to the
    caller (or framework error handler).

    Args:
        client: A sync ``AtlaSentClient`` instance.
        action_type: The action type to authorize.
        actor_id: Static actor ID. If empty, uses ``actor_id_kwarg``.
        context: Static context dict merged with any dynamic context.
        actor_id_kwarg: Name of a kwarg on the wrapped function to
            use as the actor ID (e.g. ``"agent_id"``).
        context_kwarg: Name of a kwarg on the wrapped function to
            use as additional context.
    """

    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            resolved_actor = actor_id
            if actor_id_kwarg and actor_id_kwarg in kwargs:
                resolved_actor = str(kwargs[actor_id_kwarg])

            resolved_ctx = dict(context or {})
            if context_kwarg and context_kwarg in kwargs:
                extra = kwargs[context_kwarg]
                if isinstance(extra, dict):
                    resolved_ctx.update(extra)

            logger.debug("guard: gating %s for actor=%r", action_type, resolved_actor)
            result = client.gate(action_type, resolved_actor, resolved_ctx)
            kwargs["gate_result"] = result
            return fn(*args, **kwargs)

        return wrapper

    return decorator


def async_atlasent_guard(
    client: AsyncAtlaSentClient,
    action_type: str,
    *,
    actor_id: str = "",
    context: dict[str, Any] | None = None,
    actor_id_kwarg: str = "",
    context_kwarg: str = "",
) -> Callable:
    """Async decorator that gates a function behind AtlaSent authorization.

    Same as :func:`atlasent_guard` but for async functions and
    ``AsyncAtlaSentClient``.
    """

    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            resolved_actor = actor_id
            if actor_id_kwarg and actor_id_kwarg in kwargs:
                resolved_actor = str(kwargs[actor_id_kwarg])

            resolved_ctx = dict(context or {})
            if context_kwarg and context_kwarg in kwargs:
                extra = kwargs[context_kwarg]
                if isinstance(extra, dict):
                    resolved_ctx.update(extra)

            logger.debug(
                "guard: gating %s for actor=%r (async)",
                action_type,
                resolved_actor,
            )
            result = await client.gate(action_type, resolved_actor, resolved_ctx)
            kwargs["gate_result"] = result
            return await fn(*args, **kwargs)

        return wrapper

    return decorator
