"""Unit tests for PermitCache."""

import time

from atlasent.cache import PermitCache


def test_cache_hit() -> None:
    cache = PermitCache(ttl=60)
    cache.set("agent", "action", {"k": "v"}, "result")
    assert cache.get("agent", "action", {"k": "v"}) == "result"


def test_cache_miss_different_context() -> None:
    cache = PermitCache(ttl=60)
    cache.set("agent", "action", {"k": "v"}, "result")
    assert cache.get("agent", "action", {"k": "other"}) is None


def test_cache_expiry() -> None:
    cache = PermitCache(ttl=0.01)
    cache.set("agent", "action", {}, "result")
    time.sleep(0.02)
    assert cache.get("agent", "action", {}) is None


def test_cache_clear() -> None:
    cache = PermitCache(ttl=60)
    cache.set("agent", "action", {}, "result")
    cache.clear()
    assert cache.get("agent", "action", {}) is None


def test_cache_max_size_evicts() -> None:
    cache = PermitCache(ttl=60, max_size=2)
    cache.set("agent", "a1", {}, "r1")
    cache.set("agent", "a2", {}, "r2")
    cache.set("agent", "a3", {}, "r3")
    assert len(cache._store) == 2
