"""AtlaSent SDK — execution-time authorization for AI agents.

Fail-closed by design: any failure to confirm authorization raises
an exception, so no action can proceed without an explicit permit.

Quick start::

    from atlasent import AtlaSentClient

    client = AtlaSentClient(api_key="ask_live_...")
    result = client.gate("read_patient_record", "agent-1",
                         {"patient_id": "PT-001"})
    print(result.verification.permit_hash)
"""

from ._version import __version__
from .async_client import AsyncAtlaSentClient
from .authorize import evaluate, gate, verify
from .cache import TTLCache
from .client import AtlaSentClient
from .config import configure
from .exceptions import (
    AtlaSentDenied,
    AtlaSentError,
    ConfigurationError,
    RateLimitError,
)
from .guard import async_atlasent_guard, atlasent_guard
from .models import EvaluateResult, GateResult, VerifyResult

__all__ = [
    # version
    "__version__",
    # clients
    "AtlaSentClient",
    "AsyncAtlaSentClient",
    # config
    "configure",
    # convenience functions
    "evaluate",
    "verify",
    "gate",
    # models
    "EvaluateResult",
    "VerifyResult",
    "GateResult",
    # exceptions
    "AtlaSentError",
    "AtlaSentDenied",
    "ConfigurationError",
    "RateLimitError",
    # guard decorators
    "atlasent_guard",
    "async_atlasent_guard",
    # cache
    "TTLCache",
]
