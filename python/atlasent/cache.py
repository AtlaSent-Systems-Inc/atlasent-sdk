from __future__ import annotations

import hashlib
import json
import time
from typing import Any


class PermitCache:
    """Simple in-process TTL cache for permit tokens."""

    def __init__(self, ttl: float = 60.0, max_size: int = 512) -> None:
        self._ttl = ttl
        self._max_size = max_size
        self._store: dict[str, tuple[Any, float]] = {}

    def _key(self, agent: str, action: str, context: dict[str, Any]) -> str:
        raw = json.dumps({"agent": agent, "action": action, "ctx": context}, sort_keys=True)
        return hashlib.sha256(raw.encode()).hexdigest()[:32]

    def get(self, agent: str, action: str, context: dict[str, Any]) -> Any | None:
        key = self._key(agent, action, context)
        entry = self._store.get(key)
        if entry is None:
            return None
        value, expires_at = entry
        if time.monotonic() > expires_at:
            del self._store[key]
            return None
        return value

    def set(self, agent: str, action: str, context: dict[str, Any], value: Any) -> None:
        if len(self._store) >= self._max_size:
            # evict oldest
            oldest = min(self._store, key=lambda k: self._store[k][1])
            del self._store[oldest]
        key = self._key(agent, action, context)
        self._store[key] = (value, time.monotonic() + self._ttl)

    def clear(self) -> None:
        self._store.clear()
