"""Decorators that gate a function behind AtlaSent with_permit enforcement.

Usage with Flask::

    from atlasent import AtlaSentClient, EvaluateRequest
    from atlasent.guard import atlasent_guard

    client = AtlaSentClient(api_key="ak_...")

    def build_request(**kwargs):
        return EvaluateRequest(
            action_type="modify_patient_record",
            actor_id=kwargs["agent_id"],
            context={"patient_id": kwargs.get("patient_id")},
        )

    @app.route("/modify", methods=["POST"])
    @atlasent_guard(client, build_request)
    def modify(agent_id, patient_id, atlasent=None):
        # `atlasent` is a tuple (EvaluateResponse, VerifyPermitResponse).
        return {"request_id": atlasent[0].request_id}

Usage with FastAPI (async)::

    from atlasent import AsyncAtlaSentClient
    from atlasent.guard import async_atlasent_guard

    client = AsyncAtlaSentClient(api_key="ak_...")

    @app.post("/modify")
    @async_atlasent_guard(client, build_request)
    async def modify(agent_id: str, atlasent=None):
        return {"request_id": atlasent[0].request_id}
"""

from __future__ import annotations

import functools
import logging
from collections.abc import Callable
from typing import Any

from .async_client import AsyncAtlaSentClient
from .client import AtlaSentClient
from .models import EvaluateRequest

logger = logging.getLogger("atlasent")

RequestBuilder = Callable[..., EvaluateRequest]


def atlasent_guard(
    client: AtlaSentClient,
    build_request: RequestBuilder,
) -> Callable:
    """Gate a sync function behind ``client.with_permit``.

    ``build_request`` receives the decorated function's ``*args, **kwargs`` and
    returns an :class:`EvaluateRequest`. On success, the ``(evaluation,
    verification)`` tuple is passed as the ``atlasent`` kwarg. On deny or
    verification failure, the underlying exception (:class:`AuthorizationDeniedError`
    or :class:`PermitVerificationError`) propagates to the caller.
    """

    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            request = build_request(*args, **kwargs)
            logger.debug(
                "guard: gating action_type=%r actor_id=%r",
                request.action_type,
                request.actor_id,
            )
            return client.with_permit(
                request,
                lambda evaluation, verification: fn(
                    *args, **kwargs, atlasent=(evaluation, verification)
                ),
            )

        return wrapper

    return decorator


def async_atlasent_guard(
    client: AsyncAtlaSentClient,
    build_request: RequestBuilder,
) -> Callable:
    """Async counterpart to :func:`atlasent_guard`."""

    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            request = build_request(*args, **kwargs)
            logger.debug(
                "guard: gating action_type=%r actor_id=%r (async)",
                request.action_type,
                request.actor_id,
            )
            return await client.with_permit(
                request,
                lambda evaluation, verification: fn(
                    *args, **kwargs, atlasent=(evaluation, verification)
                ),
            )

        return wrapper

    return decorator
