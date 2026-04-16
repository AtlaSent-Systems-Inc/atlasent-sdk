"""AtlaSent SDK — execution-time authorization for AI agents.

Quick start::

    import atlasent

    atlasent.configure(api_key="ask_live_...")
    result = atlasent.authorize("my-agent", "read_patient_record")
    if result:
        # proceed with the action
        ...
"""

from .authorize import authorize
from .client import AtlaSentClient
from .config import configure
from .exceptions import AtlaSentError, ConfigurationError, PermissionDeniedError
from .models import AuthorizationResult

__version__ = "0.1.0"

__all__ = [
    "authorize",
    "configure",
    "AtlaSentClient",
    "AuthorizationResult",
    "AtlaSentError",
    "ConfigurationError",
    "PermissionDeniedError",
]
