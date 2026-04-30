"""atlasent-enforce — non-bypassable execution wrapper.

Forces verify-permit on every gated action and fails closed on any error
condition. Spec: contract/ENFORCE_PACK.md. Gate: contract/SIM_SCENARIOS.md
(SIM-01..SIM-10 must pass before any Preview-pack code merges).
"""

from __future__ import annotations

from ._enforce import Enforce
from .errors import DisallowedConfigError
from .types import (
    Bindings,
    EnforceCompatibleClient,
    EvaluateResponse,
    PermitOutcomeReasonCode,
    ReasonCode,
    RunRequest,
    RunResult,
    VerifiedPermit,
)

__version__ = "0.0.0"

__all__ = [
    "__version__",
    "Bindings",
    "DisallowedConfigError",
    "Enforce",
    "EnforceCompatibleClient",
    "EvaluateResponse",
    "PermitOutcomeReasonCode",
    "ReasonCode",
    "RunRequest",
    "RunResult",
    "VerifiedPermit",
]
