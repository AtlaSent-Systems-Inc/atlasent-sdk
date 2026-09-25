"""AtlaSent authorization wrapper for LlamaIndex tools."""

from .guard import (
    DEFAULT_TOOL_ACTION,
    DenialResult,
    async_with_llamaindex_guard,
    with_llamaindex_guard,
)

__all__ = [
    "DEFAULT_TOOL_ACTION",
    "DenialResult",
    "async_with_llamaindex_guard",
    "with_llamaindex_guard",
]
