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
from .authorize import authorize, evaluate, export_audit, gate, verify
from .cache import TTLCache
from .client import AtlaSentClient
from .config import configure
from .exceptions import (
    AtlaSentDenied,
    AtlaSentError,
    AtlaSentErrorCode,
    ConfigurationError,
    PermissionDeniedError,
    RateLimitError,
)
from .guard import async_atlasent_guard, atlasent_guard
from .models import (
    AuditExportBundle,
    AuditExportHead,
    AuditExportRequest,
    AuthorizationResult,
    EvaluateResult,
    GateResult,
    VerifyResult,
)
from .verify_export import (
    ExportVerifyResult,
    verify_audit_export,
    verify_bundle,
)

__all__ = [
    "__version__",
    "AtlaSentClient",
    "AsyncAtlaSentClient",
    "configure",
    "authorize",
    "evaluate",
    "verify",
    "gate",
    "export_audit",
    "AuthorizationResult",
    "EvaluateResult",
    "VerifyResult",
    "GateResult",
    "AuditExportBundle",
    "AuditExportHead",
    "AuditExportRequest",
    "verify_bundle",
    "verify_audit_export",
    "ExportVerifyResult",
    "AtlaSentError",
    "AtlaSentErrorCode",
    "AtlaSentDenied",
    "PermissionDeniedError",
    "ConfigurationError",
    "RateLimitError",
    "atlasent_guard",
    "async_atlasent_guard",
    "TTLCache",
]
