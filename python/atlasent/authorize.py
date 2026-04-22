"""Top-level convenience functions using a module-level client singleton."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TypeVar

from .client import AtlaSentClient
from .config import get_api_key, get_base_url
from .models import (
    EvaluateRequest,
    EvaluateResponse,
    VerifyPermitRequest,
    VerifyPermitResponse,
)

logger = logging.getLogger("atlasent")

T = TypeVar("T")

_default_client: AtlaSentClient | None = None


def _get_default_client() -> AtlaSentClient:
    """Return a lazily-created singleton client for connection pooling."""
    global _default_client  # noqa: PLW0603
    if _default_client is None:
        logger.debug("Creating default AtlaSentClient singleton")
        _default_client = AtlaSentClient(
            api_key=get_api_key(),
            base_url=get_base_url(),
        )
    return _default_client


def _reset_default_client() -> None:
    """Close and discard the cached default client. For testing."""
    global _default_client  # noqa: PLW0603
    if _default_client is not None:
        _default_client.close()
        _default_client = None


def evaluate(request: EvaluateRequest) -> EvaluateResponse:
    """Shortcut for ``AtlaSentClient.evaluate`` using the module-level client."""
    return _get_default_client().evaluate(request)


def authorize(request: EvaluateRequest) -> EvaluateResponse:
    """Shortcut for ``AtlaSentClient.authorize`` using the module-level client."""
    return _get_default_client().authorize(request)


def verify_permit(request: VerifyPermitRequest) -> VerifyPermitResponse:
    """Shortcut for ``AtlaSentClient.verify_permit`` using the module-level client."""
    return _get_default_client().verify_permit(request)


def with_permit(
    request: EvaluateRequest,
    fn: Callable[[EvaluateResponse, VerifyPermitResponse], T],
) -> T:
    """Shortcut for ``AtlaSentClient.with_permit`` using the module-level client."""
    return _get_default_client().with_permit(request, fn)
