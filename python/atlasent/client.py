"""Synchronous AtlaSent API client (httpx-based)."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import uuid
import warnings
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlparse

import httpx

from ._version import __version__
from .access_governance_log import AccessGovernanceLogClient
from .approval_artifact import ApprovalReference
from .audit import AuditEventsResult, AuditExportResult
from .evidence_bundle import EvidenceBundlesClient
from .exceptions import (
    AtlaSentDenied,
    AtlaSentDeniedError,
    AtlaSentError,
    BundleVerificationError,
    PermissionDeniedError,
    RateLimitError,
    _normalize_permit_outcome,
)
from .governance_agents import (
    GovernanceAgent,
    GovernanceAgentEvaluation,
    GovernanceAgentFinding,
    ListGovernanceAgentsResult,
    ListGovernanceEvaluationsResult,
    ListGovernanceFindingsResult,
)
from .hitl import (
    HitlApprovalsResult,
    HitlChainResult,
    HitlCreateRequest,
    HitlEscalation,
    HitlEscalationResult,
    HitlStatus,
    ListHitlEscalationsResult,
)
from .models import (
    ApiKeySelfResult,
    AuthorizationResult,
    ConstraintTrace,
    EvaluatePreflightResult,
    EvaluateRequest,
    EvaluateResult,
    GateResult,
    GetPermitResult,
    ListPermitsResult,
    Permit,
    PermitRecord,
    PermitVerifyEvidence,
    RateLimitState,
    ReplayResponse,
    ReplayVarianceKind,
    RevokePermitByIdResult,
    RevokePermitResult,
    Scope,
    SubjectTagSet,
    TagSetResult,
    VerifyPermitResult,
)
from .policy import PolicyResult
from .roles import RoleAssignmentsResult, RolesResult
from .scim import (
    ScimGroup,
    ScimGroupListResponse,
    ScimGroupMember,
    ScimUser,
    ScimUserListResponse,
)
from .trust_root import get_global_trust_root_manager
from .webhooks import WebhookResult, WebhooksResult

if TYPE_CHECKING:
    from .models import ActionContext

log = logging.getLogger(__name__)