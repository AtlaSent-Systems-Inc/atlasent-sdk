from __future__ import annotations
import httpx
from typing import Any


class AtlaSentError(Exception):
    def __init__(self, message: str, status: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


class AtlaSentClient:
    def __init__(self, *, api_url: str, api_key: str, timeout: float = 10.0):
        self._api_url = api_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._headers = {
            "Content-Type": "application/json",
            "X-AtlaSent-Key": api_key,
        }

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = f"{self._api_url}{path}"
        with httpx.Client(timeout=self._timeout) as client:
            res = client.request(method, url, headers=self._headers, **kwargs)
        if not res.is_success:
            try:
                err = res.json()
            except Exception:
                err = {"message": res.text}
            raise AtlaSentError(err.get("message", "Request failed"), status=res.status_code, code=err.get("code"))
        return res.json()

    def evaluate(self, actor: dict, action: dict, target: dict, context: dict | None = None) -> dict:
        payload: dict = {"actor": actor, "action": action, "target": target}
        if context:
            payload["context"] = context
        return self._request("POST", "/v1/evaluate", json=payload)

    def authorize(self, actor: dict, action: dict, target: dict) -> bool:
        result = self.evaluate(actor, action, target)
        return result.get("decision") == "allow"

    def verify_permit(self, permit_id: str) -> dict:
        return self._request("POST", f"/v1/permits/{permit_id}/verify")

    def consume_permit(self, permit_id: str) -> dict:
        return self._request("POST", f"/v1/permits/{permit_id}/consume")

    def get_session(self) -> dict:
        return self._request("GET", "/v1/session")

    def list_audit_events(self, **params: Any) -> dict:
        return self._request("GET", "/v1/audit/events", params=params)
