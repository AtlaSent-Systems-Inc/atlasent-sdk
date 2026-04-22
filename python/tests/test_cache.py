"""Unit tests for TTLCache."""

from __future__ import annotations

import time

import httpx
import respx

from atlasent import AtlaSentClient, EvaluateRequest, EvaluateResponse
from atlasent.cache import TTLCache

BASE_URL = "https://api.atlasent.test"


def _evaluate_body(**overrides):
    body = {
        "decision": "allow",
        "request_id": "r-1",
        "mode": "live",
        "cache_hit": False,
        "evaluation_ms": 5,
        "permit_token": "pt_abc",
        "expires_at": "2026-01-01T00:00:00Z",
    }
    body.update(overrides)
    return body


class TestTTLCache:
    def test_put_and_get(self) -> None:
        cache = TTLCache(ttl=10)
        cache.put("k1", "v1")
        assert cache.get("k1") == "v1"

    def test_miss_returns_none(self) -> None:
        assert TTLCache(ttl=10).get("missing") is None

    def test_expired_entry_returns_none(self) -> None:
        cache = TTLCache(ttl=0.01)
        cache.put("k1", "v1")
        time.sleep(0.02)
        assert cache.get("k1") is None

    def test_max_size_evicts_oldest(self) -> None:
        cache = TTLCache(ttl=60, max_size=2)
        cache.put("k1", "v1")
        cache.put("k2", "v2")
        cache.put("k3", "v3")  # evicts k1
        assert cache.get("k1") is None
        assert cache.get("k2") == "v2"
        assert cache.get("k3") == "v3"

    def test_clear(self) -> None:
        cache = TTLCache(ttl=60)
        cache.put("k1", "v1")
        cache.clear()
        assert cache.size == 0

    def test_make_key_is_deterministic(self) -> None:
        k1 = TTLCache.make_key("a", "u", {"x": 1, "y": 2})
        k2 = TTLCache.make_key("a", "u", {"y": 2, "x": 1})  # different insertion order
        assert k1 == k2


class TestClientCache:
    @respx.mock
    def test_allow_is_cached_and_second_call_skips_http(self) -> None:
        cache = TTLCache(ttl=30)
        client = AtlaSentClient(
            api_key="ak", base_url=BASE_URL, max_retries=0, cache=cache
        )
        route = respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(200, json=_evaluate_body())
        )
        req = EvaluateRequest(action_type="a", actor_id="u", context={"x": 1})

        first = client.evaluate(req)
        second = client.evaluate(req)

        assert isinstance(first, EvaluateResponse)
        assert second.decision == "allow"
        assert route.call_count == 1, "second call must hit the cache"

    @respx.mock
    def test_deny_is_not_cached(self) -> None:
        cache = TTLCache(ttl=30)
        client = AtlaSentClient(
            api_key="ak", base_url=BASE_URL, max_retries=0, cache=cache
        )
        route = respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(
                200, json=_evaluate_body(decision="deny", permit_token=None)
            )
        )
        req = EvaluateRequest(action_type="a", actor_id="u")
        client.evaluate(req)
        client.evaluate(req)
        # Deny responses must not be cached -- policy could have changed, and
        # caching a deny would mask that.
        assert route.call_count == 2
