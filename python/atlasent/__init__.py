"""AtlaSent SDK — execution-time authorization for AI agents.

Fail-closed by design: any failure to confirm authorization raises
an exception, so no action can proceed without an explicit permit.

Quick start::

    from atlasent import protect

    permit = protect(
        agent="deploy-bot",
        action="deploy_to_production",
        context={"commit": commit, "approver": approver},
    )
    # If we got here, the action is authorized end-to-end.
    # Otherwise protect() raised and the action never ran.

``protect()`` is the category primitive: one call, fail-closed, never
returns a "denied" value. See :func:`atlasent.authorize` for the
older data-not-exception idiom if you prefer to branch on
``result.permitted``.
"""

from ._version import __version__
from .async_client import AsyncAtlaSentClient
from .audit import (
    AuditDecision,
    AuditEvent,
    AuditEventsResult,
    AuditExportResult,
    AuditExportSignatureStatus,
)
from .audit_bundle import (
    BundleVerificationResult,
    VerifyKey,
    verify_audit_bundle,
    verify_bundle,
)
from .authorize import authorize, evaluate, gate, protect, verify
from .cache import TTLCache
from .client import AtlaSentClient
from .config import configure
from .exceptions import (
    AtlaSentDecision,
    AtlaSentDenied,
    AtlaSentDeniedError,
    AtlaSentError,
    AtlaSentErrorCode,
    ConfigurationError,
    PermissionDeniedError,
    RateLimitError,
)
from .guard import async_atlasent_guard, atlasent_guard
from .models import (
    ApiKeySelfResult,
    AuthorizationResult,
    EvaluateResult,
    GateResult,
    Permit,
    RateLimitState,
    VerifyResult,
)
from .sso import (
    SsoCanonicalRole,
    SsoConnection,
    SsoEvent,
    SsoEventsPage,
    SsoEventType,
    SsoJitRule,
    SsoProtocol,
)

__all__ = [
    "__version__",
    "AtlaSentClient",
    "AsyncAtlaSentClient",
    "configure",
    "protect",
    "authorize",
    "evaluate",
    "verify",
    "gate",
    "Permit",
    "AuthorizationResult",
    "EvaluateResult",
    "VerifyResult",
    "RateLimitState",
    "ApiKeySelfResult",
    "GateResult",
    "AtlaSentError",
    "AtlaSentErrorCode",
    "AtlaSentDecision",
    "AtlaSentDenied",
    "AtlaSentDeniedError",
    "PermissionDeniedError",
    "ConfigurationError",
    "RateLimitError",
    "atlasent_guard",
    "async_atlasent_guard",
    "TTLCache",
    "verify_bundle",
    "verify_audit_bundle",
    "BundleVerificationResult",
    "VerifyKey",
    "AuditDecision",
    "AuditEvent",
    "AuditEventsResult",
    "AuditExportResult",
    "AuditExportSignatureStatus",
    "SsoCanonicalRole",
    "SsoConnection",
    "SsoEvent",
    "SsoEventsPage",
    "SsoEventType",
    "SsoJitRule",
    "SsoProtocol",
]
