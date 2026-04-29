from __future__ import annotations

from typing import Any, TypeVar

from .errors import DisallowedConfigError
from .types import Bindings, EnforceCompatibleClient, RunRequest, RunResult

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

    async def run(self, request: RunRequest[T]) -> RunResult[T]:
        del request  # implementation lands behind SIM-01..SIM-10
        raise NotImplementedError(
            "Enforce.run is not yet implemented. Implementation lands behind "
            "SIM-01..SIM-10; see contract/SIM_SCENARIOS.md.",
        )

    # Avoid leaking the wrapped client in repr to discourage bypass.
    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"Enforce(bindings={self._bindings!r}, fail_closed=True)"

    # Discourage attribute access that would expose the underlying client.
    def __getattr__(self, name: str) -> Any:
        raise AttributeError(
            f"Enforce has no public attribute {name!r}. Use Enforce.run().",
        )
