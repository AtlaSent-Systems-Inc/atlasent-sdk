"""In-memory TTL cache for org metadata and static configuration lookups.

.. warning::
    Do **not** pass an instance of this cache to :class:`AtlaSentClient`
    for caching :meth:`~AtlaSentClient.evaluate` or
    :meth:`~AtlaSentClient.protect` results.  Authorization decisions
    must be re-evaluated live on every request — a cached "allow" can
    replay after a permission is revoked or a policy changes, violating
    the fail-closed contract.  This class is safe only for immutable or
    slowly-changing data such as org metadata or plan-tier config.

Usage::

    from atlasent.cache import TTLCache

    cache = TTLCache(ttl=30)  # 30-second TTL
    client = AtlaSentClient(api_key="...", cache=cache)
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from typing import Any


class TTLCache:
    """Thread-safe in-memory cache with per-entry TTL expiration.

    Args:
        ttl: Time-to-live in seconds for cached entries. Defaults to 30.
        max_size: Maximum number of entries. Oldest are evicted when full.
            Defaults to 1024.

    .. warning::
        Do **not** use this cache for :meth:`~AtlaSentClient.evaluate` or
        :meth:`~AtlaSentClient.protect` results.  Authorization decisions
        must be evaluated live on every request — caching can replay an
        "allow" after a permission is revoked or a policy changes.  Only
        use this class for org metadata, plan-tier config, or other
        slowly-changing, non-security-critical lookups.
    """

    def __init__(self, ttl: float = 30, max_size: int = 1024) -> None:
        self._ttl = ttl
        self._max_size = max_size
        self._store: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Any | None:
        """Return cached value if present and not expired, else ``None``."""
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if time.monotonic() > expires_at:
                del self._store[key]
                return None
            return value

    def put(self, key: str, value: Any) -> None:
        """Store a value with the configured TTL."""
        with self._lock:
            if len(self._store) >= self._max_size:
                self._evict_expired()
            if len(self._store) >= self._max_size:
                # Evict oldest entry
                oldest_key = next(iter(self._store))
                del self._store[oldest_key]
            self._store[key] = (time.monotonic() + self._ttl, value)

    def clear(self) -> None:
        """Remove all entries."""
        with self._lock:
            self._store.clear()

    @property
    def size(self) -> int:
        """Number of entries (including potentially expired ones)."""
        return len(self._store)

    def _evict_expired(self) -> None:
        """Remove expired entries. Caller must hold the lock."""
        now = time.monotonic()
        expired = [k for k, (exp, _) in self._store.items() if now > exp]
        for k in expired:
            del self._store[k]

    @staticmethod
    def make_key(action_type: str, actor_id: str, context: dict[str, Any]) -> str:
        """Generate a deterministic cache key from evaluate() arguments."""
        raw = json.dumps(
            {"action_type": action_type, "actor_id": actor_id, "context": context},
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(raw.encode()).hexdigest()[:16]
