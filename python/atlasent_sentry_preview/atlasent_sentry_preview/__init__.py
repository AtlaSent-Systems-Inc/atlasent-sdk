"""``atlasent-sentry-preview`` — PREVIEW.

DO NOT USE IN PRODUCTION. See ``./README.md``.
"""

from __future__ import annotations

from .with_sentry import (
    with_async_sentry,
    with_sentry,
    with_sentry_protect,
)

__version__ = "2.0.0a0"

__all__ = [
    "__version__",
    "with_async_sentry",
    "with_sentry",
    "with_sentry_protect",
]
