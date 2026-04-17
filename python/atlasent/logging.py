"""Structured JSON logging for AtlaSent SDK.

Provides a ``configure_logging`` helper that attaches a JSON formatter
to the ``atlasent`` logger, suitable for SIEM ingestion, CloudWatch,
Datadog, and other structured-log pipelines.

Usage::

    from atlasent.logging import configure_logging

    configure_logging(level="DEBUG")
    # All atlasent.* log records now emit single-line JSON to stderr
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any


class JSONFormatter(logging.Formatter):
    """Formats log records as single-line JSON objects.

    Output fields: ``timestamp``, ``level``, ``logger``, ``message``,
    plus any extras attached to the record.
    """

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(
                record.created, tz=timezone.utc
            ).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        # Include any extra fields set via logger.info("msg", extra={...})
        for key in ("action_type", "actor_id", "permit_token", "request_id"):
            val = getattr(record, key, None)
            if val is not None:
                entry[key] = val
        if record.exc_info and record.exc_info[1]:
            entry["exception"] = str(record.exc_info[1])
        return json.dumps(entry, default=str)


def configure_logging(
    level: str | int = "WARNING",
    stream: Any = None,
) -> logging.Logger:
    """Configure the ``atlasent`` logger with structured JSON output.

    Args:
        level: Log level (e.g. ``"DEBUG"``, ``"INFO"``, ``logging.WARNING``).
        stream: Output stream. Defaults to ``sys.stderr``.

    Returns:
        The configured ``atlasent`` logger.

    Example::

        from atlasent.logging import configure_logging

        configure_logging("DEBUG")
    """
    logger = logging.getLogger("atlasent")

    if isinstance(level, str):
        level = getattr(logging, level.upper(), logging.WARNING)
    logger.setLevel(level)

    # Remove existing handlers to avoid duplicates on re-configure
    for handler in logger.handlers[:]:
        logger.removeHandler(handler)

    handler = logging.StreamHandler(stream or sys.stderr)
    handler.setFormatter(JSONFormatter())
    logger.addHandler(handler)

    return logger
