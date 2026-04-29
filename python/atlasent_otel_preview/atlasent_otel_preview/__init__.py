"""``atlasent-otel-preview`` — PREVIEW.

DO NOT USE IN PRODUCTION. See ``./README.md``.
"""

from __future__ import annotations

from .with_otel import with_async_otel, with_otel, with_otel_protect

__version__ = "2.0.0a0"

__all__ = [
    "__version__",
    "with_async_otel",
    "with_otel",
    "with_otel_protect",
]
