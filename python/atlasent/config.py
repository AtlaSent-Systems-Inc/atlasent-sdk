"""Global configuration for the AtlaSent SDK."""

from __future__ import annotations

import logging
import os

from .exceptions import ConfigurationError

logger = logging.getLogger("atlasent")

DEFAULT_BASE_URL = "https://api.atlasent.io"

_global_config: dict[str, str | None] = {
    "api_key": None,
    "anon_key": None,
    "base_url": DEFAULT_BASE_URL,
}


def configure(
    api_key: str | None = None,
    *,
    anon_key: str | None = None,
    base_url: str = DEFAULT_BASE_URL,
) -> None:
    """Configure the AtlaSent SDK globally.

    Args:
        api_key: Your AtlaSent API key.  Falls back to the
            ``ATLASENT_API_KEY`` environment variable if not provided.
        anon_key: Anonymous / public key.  Falls back to
            ``ATLASENT_ANON_KEY``.
        base_url: Override the base API URL.
    """
    _global_config["api_key"] = api_key
    _global_config["anon_key"] = anon_key
    _global_config["base_url"] = base_url
    logger.debug("Configured: base_url=%s", base_url)


def get_api_key() -> str:
    """Return the configured API key, falling back to the env var.

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


def get_anon_key() -> str:
    """Return the configured anonymous key, or empty string."""
    return _global_config["anon_key"] or os.environ.get("ATLASENT_ANON_KEY") or ""


def get_base_url() -> str:
    """Return the configured base API URL."""
    return _global_config["base_url"] or DEFAULT_BASE_URL


def reset() -> None:
    """Reset global configuration to defaults.  Useful for testing."""
    _global_config["api_key"] = None
    _global_config["anon_key"] = None
    _global_config["base_url"] = DEFAULT_BASE_URL
