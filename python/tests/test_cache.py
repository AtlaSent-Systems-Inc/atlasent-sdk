"""Tests for TTLCache."""

import time

from atlasent.cache import TTLCache


class TestTTLCache:
    def test_put_and_get(self):
        cache = TTLCache(ttl=10)
        cache.put("k1", "v1")
        assert cache.get("k1") == "v1"

    def test_miss_returns_none(self):
        cache = TTLCache(ttl=10)
        assert cache.get("missing") is None

    def test_expired_entry_returns_none(self):
        cache = TTLCache(ttl=0.01)
        cache.put("k1", "v1")
        time.sleep(0.02)
        assert cache.get("k1") is None

    def test_max_size_evicts(self):
        cache = TTLCache(ttl=60, max_size=2)
        cache.put("k1", "v1")
        cache.put("k2", "v2")
        cache.put("k3", "v3")  # evicts k1
        assert cache.get("k1") is None
        assert cache.get("k2") == "v2"
        assert cache.get("k3") == "v3"

    def test_clear(self):
        cache = TTLCache(ttl=60)
        cache.put("k1", "v1")
        cache.put("k2", "v2")
        cache.clear()
        assert cache.size == 0
        assert cache.get("k1") is None

    def test_size(self):
        cache = TTLCache(ttl=60)
        assert cache.size == 0
        cache.put("k1", "v1")
        assert cache.size == 1

    def test_make_key_deterministic(self):
        k1 = TTLCache.make_key("read", "agent", {"a": 1})
        k2 = TTLCache.make_key("read", "agent", {"a": 1})
        assert k1 == k2

    def test_make_key_differs_on_input(self):
        k1 = TTLCache.make_key("read", "agent-1", {})
        k2 = TTLCache.make_key("read", "agent-2", {})
        assert k1 != k2

    def test_make_key_context_order_independent(self):
        k1 = TTLCache.make_key("read", "agent", {"a": 1, "b": 2})
        k2 = TTLCache.make_key("read", "agent", {"b": 2, "a": 1})
        assert k1 == k2


class TestCacheIntegrationWithClient:
    def test_cache_hit_skips_api(self, mocker):
        """When cache has a result, no HTTP call is made."""

        from atlasent.cache import TTLCache
        from atlasent.client import AtlaSentClient
        from atlasent.models import EvaluateResult

        cache = TTLCache(ttl=60)
        client = AtlaSentClient(api_key="k", max_retries=0, cache=cache)

        # Pre-populate cache
        cached_result = EvaluateResult(
            decision=True,
            permit_token="dec_cached",
            reason="cached",
            audit_hash="h",
            timestamp="t",
        )
        key = TTLCache.make_key("read", "agent", {})
        cache.put(key, cached_result)

        mock_post = mocker.patch.object(client._client, "post")

        result = client.evaluate("read", "agent", {})

        assert result.permit_token == "dec_cached"
        mock_post.assert_not_called()

    def test_cache_miss_calls_api(self, mocker):
        import httpx

        from atlasent.cache import TTLCache
        from atlasent.client import AtlaSentClient

        cache = TTLCache(ttl=60)
        client = AtlaSentClient(api_key="k", max_retries=0, cache=cache)

        resp = mocker.Mock(spec=httpx.Response)
        resp.status_code = 200
        resp.headers = {}
        resp.json.return_value = {
            "permitted": True,
            "decision_id": "dec_api",
            "reason": "OK",
            "audit_hash": "h",
            "timestamp": "t",
        }
        mocker.patch.object(client._client, "post", return_value=resp)

        result = client.evaluate("read", "agent", {})
        assert result.permit_token == "dec_api"

        # Second call should be cached
        result2 = client.evaluate("read", "agent", {})
        assert result2.permit_token == "dec_api"
        assert client._client.post.call_count == 1  # only one API call
