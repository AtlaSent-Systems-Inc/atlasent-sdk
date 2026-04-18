from __future__ import annotations
import asyncio
import httpx
from typing import Any
from .client import AtlaSentError


class AsyncAtlaSentClient:
    def __init__(self, *, api_url: str, api_key: str, timeout: float = 10.0):
        self._api_url = api_url.rstrip("/")
        self._headers = {
            "Content-Type": "application/json",
            "X-AtlaSent-Key": api_key,
        }
        self._timeout = timeout

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.request(method, f"{self._api_url}{path}", headers=self._headers, **kwargs)
        if not res.is_success:
            try:
                err = res.json()
            except Exception:
                err = {"message": res.text}
            raise AtlaSentError(err.get("message", "Request failed"), status=res.status_code, code=err.get("code"))
        return res.json()

    async def evaluate(self, actor: dict, action: dict, target: dict) -> dict:
        return await self._request("POST", "/v1/evaluate", json={"actor": actor, "action": action, "target": target})

    async def authorize_many(self, payloads: list[dict]) -> list[dict]:
        results = await asyncio.gather(*[self.evaluate(**p) for p in payloads], return_exceptions=True)
        return [
            {"payload": p, "result": r if not isinstance(r, Exception) else None, "error": str(r) if isinstance(r, Exception) else None}
            for p, r in zip(payloads, results)
        ]
