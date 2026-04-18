"""Synchronous AtlaSent client."""
from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from ._version import __version__
from .exceptions import (
    AtlaSentDenied,
    AtlaSentError,
    PermissionDeniedError,
    RateLimitError,
)
from .models import AuthorizationResult, EvaluateResult, GateResult, VerifyResult

logger = logging.getLogger("atlasent")

_DEFAULT_BASE_URL = "https://api.atlasent.io"


class AtlaSentClient:
    def __init__(
        self,
        *,
        api_key: str,
        anon_key: str = "",
        base_url: str = _DEFAULT_BASE_URL,
        timeout: float = 10,
        max_retries: int = 2,
        retry_backoff: float = 0.5,
    ) -> None:
        self._api_key = api_key
        self._anon_key = anon_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._retry_backoff = retry_backoff
        self._client = httpx.Client(
            base_url=self._base_url,
            timeout=timeout,
            headers={
                "accept": "application/json",
                "content-type": "application/json",
                "authorization": f"Bearer {api_key}",
                "user-agent": f"atlasent-python/{__version__}",
            },
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "AtlaSentClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def _post(self, path: str, *, json: dict) -> dict:
        last_err: Exception | None = None
        attempts = self._max_retries + 1
        for attempt in range(attempts):
            if attempt > 0:
                time.sleep(self._retry_backoff * (2 ** (attempt - 1)))
            try:
                resp = self._client.post(path, json=json)
            except httpx.TimeoutException:
                last_err = AtlaSentError(
                    f"Request to AtlaSent timed out after {self._timeout}s",
                    code="timeout",
                )
                continue
            except httpx.ConnectError as e:
                raise AtlaSentError(
                    f"Failed to connect to AtlaSent: {e}",
                    code="network",
                ) from e

            if resp.status_code == 429:
                retry_after = None
                try:
                    retry_after = float(resp.headers.get("retry-after", ""))
                except (ValueError, TypeError):
                    pass
                raise RateLimitError(retry_after=retry_after)

            if resp.status_code == 401:
                raise AtlaSentError(
                    "Invalid API key",
                    status_code=401,
                    code="invalid_api_key",
                )

            if resp.status_code == 403:
                raise AtlaSentError(
                    "Forbidden",
                    status_code=403,
                    code="forbidden",
                )

            if 500 <= resp.status_code < 600:
                last_err = AtlaSentError(
                    f"API error {resp.status_code}: {resp.text[:512]}",
                    status_code=resp.status_code,
                    code="server_error",
                )
                continue

            if 400 <= resp.status_code < 500:
                raise AtlaSentError(
                    f"API error {resp.status_code}: {resp.text[:512]}",
                    status_code=resp.status_code,
                    code="bad_request",
                )

            try:
                return resp.json()
            except ValueError as e:
                raise AtlaSentError(
                    f"Invalid JSON response from AtlaSent: {e}",
                    code="bad_response",
                ) from e

        raise AtlaSentError(
            f"Request failed after {attempts} attempts: {last_err}",
            code=getattr(last_err, "code", "server_error"),
        )

    def evaluate(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
    ) -> EvaluateResult:
        payload = {
            "action": action_type,
            "agent": actor_id,
            "context": context or {},
            "api_key": self._api_key,
        }
        raw = self._post("/v1/evaluate", json=payload)
        try:
            result = EvaluateResult.model_validate(raw)
        except Exception as e:
            raise AtlaSentError(
                "Malformed response: missing 'permitted' field",
                code="bad_response",
                response_body=raw,
            ) from e
        if not result.decision:
            raise AtlaSentDenied(
                str(result.decision),
                permit_token=result.permit_token,
                reason=result.reason,
                response_body=raw,
            )
        return result

    def verify(
        self,
        permit_token: str,
        action_type: str = "",
        actor_id: str = "",
        context: dict[str, Any] | None = None,
    ) -> VerifyResult:
        payload = {
            "decision_id": permit_token,
            "action": action_type,
            "agent": actor_id,
            "context": context or {},
            "api_key": self._api_key,
        }
        raw = self._post("/v1/verify-permit", json=payload)
        try:
            return VerifyResult.model_validate(raw)
        except Exception as e:
            raise AtlaSentError(
                "Malformed response: missing 'verified' field",
                code="bad_response",
                response_body=raw,
            ) from e

    def gate(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
    ) -> GateResult:
        evaluation = self.evaluate(action_type, actor_id, context)
        verification = self.verify(
            evaluation.permit_token, action_type, actor_id, context
        )
        return GateResult(evaluation=evaluation, verification=verification)

    def authorize(
        self,
        *,
        agent: str,
        action: str,
        context: dict[str, Any] | None = None,
        verify: bool = True,
        raise_on_deny: bool = False,
    ) -> AuthorizationResult:
        try:
            eval_result = self.evaluate(action, agent, context)
        except AtlaSentDenied as e:
            if raise_on_deny:
                raise PermissionDeniedError(
                    e.decision,
                    permit_token=e.permit_token,
                    reason=e.reason,
                    response_body=e.response_body,
                ) from e
            return AuthorizationResult(
                permitted=False,
                agent=agent,
                action=action,
                context=context or {},
                reason=e.reason,
                permit_token=e.permit_token,
            )
        if not verify:
            return AuthorizationResult(
                permitted=True,
                agent=agent,
                action=action,
                context=context or {},
                reason=eval_result.reason,
                permit_token=eval_result.permit_token,
                audit_hash=eval_result.audit_hash,
                timestamp=eval_result.timestamp,
            )
        verify_result = self.verify(
            eval_result.permit_token, action, agent, context
        )
        return AuthorizationResult(
            permitted=True,
            agent=agent,
            action=action,
            context=context or {},
            reason=eval_result.reason,
            permit_token=eval_result.permit_token,
            audit_hash=eval_result.audit_hash,
            permit_hash=verify_result.permit_hash,
            verified=verify_result.valid,
            timestamp=eval_result.timestamp,
        )
