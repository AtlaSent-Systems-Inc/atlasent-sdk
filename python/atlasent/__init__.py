"""AtlaSent SDK — execution-time authorization for AI agents.

Fail-closed by design: any failure to confirm authorization raises
an exception, so no action can proceed without an explicit permit.

Quick start::

    from atlasent import authorize

    result = authorize(
        agent="clinical-data-agent",
        action="modify_patient_record",
        context={"user": "dr_smith", "environment": "production"},
    )
    if result.permitted:
        # execute action
        ...
"""

from ._version import __version__
from .async_client import AsyncAtlaSentClient
from .authorize import authorize, evaluate, gate, verify
from .cache import TTLCache
from .client import AtlaSentClient
from .config import configure
from .exceptions import (
    AtlaSentDenied,
    AtlaSentError,
    ConfigurationError,
    PermissionDeniedError,
    RateLimitError,
)
from .guard import async_atlasent_guard, atlasent_guard
from .models import AuthorizationResult, EvaluateResult, GateResult, VerifyResult

__all__ = [
    # version
    "__version__",
    # clients
    "AtlaSentClient",
    "AsyncAtlaSentClient",
    # config
    "configure",
    # convenience functions
    "authorize",
    "evaluate",
    "verify",
    "gate",
    # models
    "AuthorizationResult",
    "EvaluateResult",
    "VerifyResult",
    "GateResult",
    # exceptions
    "AtlaSentError",
    "AtlaSentDenied",
    "PermissionDeniedError",
    "ConfigurationError",
    "RateLimitError",
    # guard decorators
    "atlasent_guard",
    "async_atlasent_guard",
    # cache
    "TTLCache",
]
