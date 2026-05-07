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

Canonical surface — three primitives, each with a distinct
lifecycle:

- :func:`atlasent.protect` — fail-closed execution primitive.
  Use when the caller wants "no permit, no execution." Raises on
  ``deny``, ``hold``, ``escalate``, or verification failure.
- :func:`atlasent.evaluate` — raw decision primitive. Use when the
  caller needs to inspect the four-value decision
  (``allow`` / ``deny`` / ``hold`` / ``escalate``). Does not
  collapse states; does not pretend denial is a permit path.
- :func:`atlasent.verify` — post-permit verification primitive,
  for callers that already hold a permit token.

``authorize()`` and ``gate()`` are deprecated legacy convenience
wrappers and will be removed in ``atlasent`` v3. Migrate to
``protect()`` (for fail-closed) or ``evaluate()`` (to inspect).
"""

from ._version import __version__
from .approval_artifact import (
    ApprovalArtifactV1,
    ApprovalIssuer,
    ApprovalQuorumV1,
    ApprovalReference,
    ApprovalReviewer,
    ApprovalTrustedIssuersConfig,
    IdentityAssertionBinding,
    IdentityAssertionV1,
    IdentityIssuer,
    IdentityIssuerKey,
    IdentitySubject,
    IdentityTrustedIssuersConfig,
    PermitApprovalBinding,
    PrincipalKind,
    QuorumIndependence,
    QuorumPolicy,
    QuorumProof,
    QuorumRoleRequirement,
    TrustedIssuerKey,
)
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
    PermitOutcome,
    RateLimitError,
)
from .guard import async_atlasent_guard, atlasent_guard
from .models import (
    ApiKeySelfResult,
    AuthorizationResult,
    ConstraintTrace,
    ConstraintTracePolicy,
    ConstraintTraceStage,
    EvaluatePreflightResult,
    EvaluateResult,
    GateResult,
    GetPermitResult,
    ListPermitsResult,
    Permit,
    PermitRecord,
    PermitVerifyEvidence,
    RateLimitState,
    RevokePermitByIdResult,
    RevokePermitResult,
    StreamDecisionEvent,
    VerifyPermitByIdResult,
    StreamEvent,
    StreamProgressEvent,
    VerifyResult,
)
from .require_permit import ProtectedAction, classify_command, require_permit
from .with_permit import with_permit

__all__ = [
    "__version__",
    "AtlaSentClient",
    "AsyncAtlaSentClient",
    "configure",
    "protect",
    "with_permit",
    "require_permit",
    "classify_command",
    "ProtectedAction",
    "authorize",
    "evaluate",
    "verify",
    "gate",
    "Permit",
    "AuthorizationResult",
    "EvaluateResult",
    "EvaluatePreflightResult",
    "ConstraintTrace",
    "ConstraintTracePolicy",
    "ConstraintTraceStage",
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
    "PermitOutcome",
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
    "RevokePermitResult",
    "RevokePermitByIdResult",
    "VerifyPermitByIdResult",
    "PermitVerifyEvidence",
    "GetPermitResult",
    "ListPermitsResult",
    "PermitRecord",
    "StreamDecisionEvent",
    "StreamProgressEvent",
    "StreamEvent",
    # Approval artifact contract surface (parity with the TS SDK).
    "ApprovalArtifactV1",
    "ApprovalIssuer",
    "ApprovalQuorumV1",
    "ApprovalReference",
    "ApprovalReviewer",
    "ApprovalTrustedIssuersConfig",
    "IdentityAssertionBinding",
    "IdentityAssertionV1",
    "IdentityIssuer",
    "IdentityIssuerKey",
    "IdentitySubject",
    "IdentityTrustedIssuersConfig",
    "PermitApprovalBinding",
    "PrincipalKind",
    "QuorumIndependence",
    "QuorumPolicy",
    "QuorumProof",
    "QuorumRoleRequirement",
    "TrustedIssuerKey",
]
