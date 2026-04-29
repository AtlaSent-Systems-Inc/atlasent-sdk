"""``atlasent-v2-alpha`` — alpha release of the v2 SDK surface.

The API exported here mirrors the v2 wire schemas (``contract/schemas/v2/``)
and is published to PyPI as ``atlasent-v2-alpha``. Surfaces are usable but
considered alpha — the API is subject to change between alpha releases.
Pin to an exact version if you depend on this package from production code.
"""

from __future__ import annotations

from .canonicalize import canonicalize_payload
from .client import AtlaSentV2Client, V2Error
from .hash import hash_payload
from .types import (
    BatchEvaluateItem,
    BatchEvaluateResponseItem,
    BatchProofStatus,
    ConsumeExecutionStatus,
    ConsumeRequest,
    ConsumeResponse,
    EvaluateBatchRequest,
    EvaluateBatchResponse,
    Proof,
    ProofCheckName,
    ProofDecision,
    ProofExecutionStatus,
    ProofFailureReason,
    ProofVerificationCheck,
    ProofVerificationResult,
    ProofVerificationStatus,
)

__version__ = "2.0.0a0"

__all__ = [
    "__version__",
    "canonicalize_payload",
    "hash_payload",
    "AtlaSentV2Client",
    "V2Error",
    "BatchEvaluateItem",
    "BatchEvaluateResponseItem",
    "BatchProofStatus",
    "ConsumeExecutionStatus",
    "ConsumeRequest",
    "ConsumeResponse",
    "EvaluateBatchRequest",
    "EvaluateBatchResponse",
    "Proof",
    "ProofCheckName",
    "ProofDecision",
    "ProofExecutionStatus",
    "ProofFailureReason",
    "ProofVerificationCheck",
    "ProofVerificationResult",
    "ProofVerificationStatus",
]
