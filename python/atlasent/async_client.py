"""Async AtlaSent client for use with asyncio / async frameworks."""
from __future__ import annotations
import asyncio
from typing import Any, Dict, List, Optional


class AsyncAtlaSentClient:
    """Async version of AtlaSentClient. Uses httpx.AsyncClient internally."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "https://api.atlasent.io",
    ) -> None:
        import os
        self._api_key = api_key or os.environ.get("ATLASENT_API_KEY", "")
        self._base_url = base_url.rstrip("/")

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}

    async def authorize(
        self,
        action: str,
        context: Optional[Dict[str, Any]] = None,
        agent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        import httpx
        payload: Dict[str, Any] = {"action": action}
        if context:
            payload["context"] = context
        if agent_id:
            payload["agent_id"] = agent_id
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self._base_url}/v1/evaluate",
                json=payload,
                headers=self._headers(),
            )
            resp.raise_for_status()
            return resp.json()

    async def verify_permit(self, permit_id: str) -> Dict[str, Any]:
        import httpx
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self._base_url}/v1/verify-permit",
                json={"permit_id": permit_id},
                headers=self._headers(),
            )
            resp.raise_for_status()
            return resp.json()

    async def authorize_many(self, requests: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Evaluate multiple actions concurrently."""
        tasks = [
            self.authorize(
                action=r["action"],
                context=r.get("context"),
                agent_id=r.get("agent_id"),
            )
            for r in requests
        ]
        return list(await asyncio.gather(*tasks))
