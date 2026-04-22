"""AtlaSent SDK -- execution-time authorization for AI agents and services.

Fail-closed by design: any failure to reach a definitive ``allow`` decision
raises, so no action can proceed without an explicit, verified permit.

Quick start::

    from atlasent import AtlaSentClient, EvaluateRequest

    with AtlaSentClient(api_key="ak_...") as client:
        res = client.authorize(EvaluateRequest(
            action_type="payment.transfer",
            actor_id="user:42",
            context={"amount": 1000},
        ))
        # res.decision == "allow"; res.permit_token is set.

    # Full enforcement with single-use permit consumption:
    client.with_permit(
        EvaluateRequest(action_type="payment.transfer", actor_id="user:42"),
        lambda evaluation, verification: do_transfer(),
    )
"""

from ._version import __version__
from .async_client import AsyncAtlaSentClient
from .authorize import authorize, evaluate, verify_permit, with_permit
from .cache import TTLCache
from .client import AtlaSentClient
from .config import configure
from .exceptions import (
    AtlaSentError,
    AtlaSentErrorCode,
    AuthorizationDeniedError,
    AuthorizationUnavailableError,
    ConfigurationError,
    PermitVerificationError,
    RateLimitError,
)
from .guard import async_atlasent_guard, atlasent_guard
from .models import (
    ApiErrorBody,
    Decision,
    EvaluateRequest,
    EvaluateResponse,
    RolloutInfo,
    RuleTraceEntry,
    ShadowResult,
    VerifyErrorCode,
    VerifyPermitRequest,
    VerifyPermitResponse,
    is_allowed,
)

__all__ = [
    "__version__",
    # Clients
    "AtlaSentClient",
    "AsyncAtlaSentClient",
    # Module-level convenience
    "configure",
    "evaluate",
    "authorize",
    "verify_permit",
    "with_permit",
    # Models
    "Decision",
    "EvaluateRequest",
    "EvaluateResponse",
    "VerifyPermitRequest",
    "VerifyPermitResponse",
    "VerifyErrorCode",
    "RolloutInfo",
    "ShadowResult",
    "RuleTraceEntry",
    "ApiErrorBody",
    "is_allowed",
    # Exceptions
    "AtlaSentError",
    "AtlaSentErrorCode",
    "AuthorizationDeniedError",
    "AuthorizationUnavailableError",
    "PermitVerificationError",
    "ConfigurationError",
    "RateLimitError",
    # Guards
    "atlasent_guard",
    "async_atlasent_guard",
    # Cache
    "TTLCache",
]
