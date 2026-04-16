"""AtlaSent SDK — execution-time authorization for AI agents.

Quick start::

    import atlasent

    atlasent.configure(api_key="ask_live_...")
    result = atlasent.authorize("my-agent", "read_patient_record")
    if result:
        # proceed with the action
        ...
"""

from ._version import __version__
from .async_client import AsyncAtlaSentClient
from .authorize import authorize
from .client import AtlaSentClient
from .config import configure
from .exceptions import (
    AtlaSentError,
    ConfigurationError,
    PermissionDeniedError,
    RateLimitError,
)
from .models import AuthorizationResult

__all__ = [
    "authorize",
    "configure",
    "AtlaSentClient",
    "AsyncAtlaSentClient",
    "AuthorizationResult",
    "AtlaSentError",
    "ConfigurationError",
    "PermissionDeniedError",
    "RateLimitError",
    "__version__",
]
