from __future__ import annotations

from typing import Any

import httpx

from .exceptions import (
    AtlaSentAPIError,
    AtlaSentDeniedError,
    AtlaSentEscalateError,
    AtlaSentHoldError,
)
from .models import (
    AuthorizeResult,
    Decision,
    EvaluateResponse,
    VerifyPermitRequest,
    VerifyPermitResponse,
)


class AsyncAtlaSentClient:
    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.atlasent.io",
        timeout: float = 10.0,
    ) -> None:
        self._http = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=timeout,
        )

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        resp = await self._http.post(path, json=body)
        if not resp.is_success:
            raise AtlaSentAPIError(resp.status_code, resp.text)
        return resp.json()

    async def evaluate(
        self,
        agent_id: str,
        action_type: str,
        context: dict[str, Any] | None = None,
        fail_mode: str = "closed",
    ) -> EvaluateResponse:
        data = await self._post(
            "/v1/evaluate",
            {
                "agentId": agent_id,
                "actionType": action_type,
                "context": context or {},
                "failMode": fail_mode,
            },
        )
        return EvaluateResponse.model_validate(data)

    async def authorize(
        self,
        agent: str,
        action: str,
        context: dict[str, Any] | None = None,
        fail_mode: str = "closed",
    ) -> AuthorizeResult:
        resp = await self.evaluate(agent, action, context, fail_mode)
        if resp.decision == Decision.deny:
            raise AtlaSentDeniedError(resp.deny_code or "DENIED", resp)
        if resp.decision == Decision.hold:
            raise AtlaSentHoldError(resp.deny_code or "HOLD", resp)
        if resp.decision == Decision.escalate:
            raise AtlaSentEscalateError(resp.escalate_to or "", resp)
        return AuthorizeResult(
            decision=resp.decision,
            deny_code=resp.deny_code,
            escalate_to=resp.escalate_to,
            permit_token=resp.permit_token,
            meta=resp.meta,
        )

    async def verify_permit(
        self,
        permit_token: str,
        action_type: str,
    ) -> VerifyPermitResponse:
        req = VerifyPermitRequest(permit_token=permit_token, action_type=action_type)
        data = await self._post("/v1/verify-permit", req.model_dump(by_alias=True))
        return VerifyPermitResponse.model_validate(data)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "AsyncAtlaSentClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()
