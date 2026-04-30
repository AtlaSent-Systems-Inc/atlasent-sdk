"""AtlaSent authorization wrapper for LlamaIndex tools."""

from .guard import DenialResult, async_with_llamaindex_guard, with_llamaindex_guard

__all__ = [
    "DenialResult",
    "async_with_llamaindex_guard",
    "with_llamaindex_guard",
]
