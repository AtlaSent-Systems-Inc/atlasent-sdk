from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any, TypeVar

from .errors import DisallowedConfigError, LatencyBreachError, classify_client_error
from .types import (
    Bindings,
    EnforceCompatibleClient,
    RunRequest,
    RunResult,
    VerifiedPermit,
)

T = TypeVar("T")


class Enforce:
    def __init__(
        self,
        *,
        client: EnforceCompatibleClient,
        bindings: Bindings,
        fail_closed: bool,
        latency_budget_ms: int | None = None,
        latency_breach_mode: str = "deny",
        on_latency_breach: Callable[[], None] | None = None,
    ) -> None:
        if fail_closed is not True:
            raise DisallowedConfigError(
                "Enforce.fail_closed must be True. Fail-closed is non-toggleable; "
                "see contract/ENFORCE_PACK.md invariant 2.",
            )
        self._client = client
        self._bindings = bindings
        self._latency_budget_ms = latency_budget_ms
        self._latency_breach_mode = latency_breach_mode
        self._on_latency_breach = on_latency_breach

    async def run(self, request: RunRequest[T]) -> RunResult[T]:
        # Step 1: evaluate
        try:
            # enforce-no-bypass: allow
            eval_response = await self._client.evaluate(request.request)
        except Exception as exc:
            return RunResult(
                decision="deny",
                reason_code=classify_client_error(exc, "evaluate_unavailable"),
            )

        if eval_response.decision != "allow" or not eval_response.permit_token:
            return RunResult(
                decision=eval_response.decision,
                reason_code=eval_response.reason_code or eval_response.decision,
            )

        permit_token = eval_response.permit_token

        # Step 2: verifyPermit (with optional latency budget)
        try:
            verified_permit = await self._verify_with_budget(permit_token)
        except LatencyBreachError:
            return RunResult(decision="deny", reason_code="verify_latency_breach")
        except Exception as exc:
            return RunResult(
                decision="deny",
                reason_code=classify_client_error(exc, "verify_unavailable"),
            )

        # Step 3: binding check
        b = self._bindings
        if (
            verified_permit.org_id != b.org_id
            or verified_permit.actor_id != b.actor_id
            or verified_permit.action_type != b.action_type
        ):
            return RunResult(decision="deny", reason_code="binding_mismatch")

        # Step 4: execute
        value = await request.execute(verified_permit)
        return RunResult(decision="allow", value=value, permit=verified_permit)

    async def _verify_with_budget(self, token: str) -> VerifiedPermit:
        if self._latency_budget_ms is None:
            return await self._client.verify_permit(token)

        verify_coro = self._client.verify_permit(token)
        timeout_s = self._latency_budget_ms / 1000.0

        verify_task = asyncio.ensure_future(verify_coro)
        done, pending = await asyncio.wait(
            [verify_task],
            timeout=timeout_s,
        )

        if verify_task in done:
            return verify_task.result()

        # Latency budget breached
        if self._latency_breach_mode == "warn":
            if self._on_latency_breach:
                self._on_latency_breach()
            return await verify_task  # wait for actual result

        verify_task.cancel()
        raise LatencyBreachError()

    def __repr__(self) -> str:  # pragma: no cover
        return f"Enforce(bindings={self._bindings!r}, fail_closed=True)"

    def __getattr__(self, name: str) -> Any:
        raise AttributeError(
            f"Enforce has no public attribute {name!r}. Use Enforce.run().",
        )
