"""Global configuration for the AtlaSent SDK."""

import logging
import os
from typing import Optional

from .exceptions import ConfigurationError

logger = logging.getLogger("atlasent")

DEFAULT_BASE_URL = "https://api.atlasent.io"

_global_config: dict = {
    "api_key": None,
    "environment": "production",
    "base_url": DEFAULT_BASE_URL,
}


def configure(
    api_key: Optional[str] = None,
    environment: str = "production",
    base_url: str = DEFAULT_BASE_URL,
) -> None:
    """Configure the AtlaSent SDK globally.

    Args:
        api_key: Your AtlaSent API key. Falls back to the
            ATLASENT_API_KEY environment variable if not provided.
        environment: Deployment environment name (e.g., "production",
            "staging"). Defaults to "production".
        base_url: Override the base API URL. Defaults to
            https://api.atlasent.io.
    """
    _global_config["api_key"] = api_key
    _global_config["environment"] = environment
    _global_config["base_url"] = base_url
    logger.debug(
        "Configured: environment=%s, base_url=%s", environment, base_url
    )


def get_api_key() -> str:
    """Return the configured API key, falling back to the environment variable.

    Raises:
        ConfigurationError: If no API key is available.
    """
    key = _global_config["api_key"] or os.environ.get("ATLASENT_API_KEY")
    if not key:
        raise ConfigurationError(
            "No API key provided. Either call atlasent.configure(api_key=...) "
            "or set the ATLASENT_API_KEY environment variable."
        )
    return key


def get_environment() -> str:
    """Return the configured environment name."""
    return _global_config["environment"]


def get_base_url() -> str:
    """Return the configured base API URL."""
    return _global_config["base_url"]


def reset() -> None:
    """Reset global configuration to defaults. Useful for testing."""
    _global_config["api_key"] = None
    _global_config["environment"] = "production"
    _global_config["base_url"] = DEFAULT_BASE_URL
