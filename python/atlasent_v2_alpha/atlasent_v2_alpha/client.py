"""V2 HTTP client (synchronous, httpx-based).

Surfaces the v2 lifecycle methods the alpha pack ships:

* ``consume()``      — close a permit lifecycle with a proof
* ``verify_proof()`` — server-side verification of an emitted proof

Future PRs in the v2-alpha series add ``evaluate_batch()`` and
``subscribe_decisions()``. Each method returns a pydantic model that
mirrors the corresponding v2 schema in ``contract/schemas/v2/``.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any, Literal

import httpx

from .sse import parse_sse_lines
from .types import (
    BatchEvaluateItem,
    ConsumeRequest,
    ConsumeResponse,
    DecisionEvent,
    EvaluateBatchRequest,
    EvaluateBatchResponse,
    ProofVerificationResult,
)

DEFAULT_BASE_URL = "https://api.atlasent.io"
DEFAULT_TIMEOUT = 10.0


class V2Error(Exception):
    """Raised for any non-2xx response, network failure, or timeout."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: str | None = None,
        response_body: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.response_body = response_body


class AtlaSentV2Client:
    """Synchronous client for the v2 AtlaSent API.

    Args:
        api_key: Your AtlaSent API key (required).
        base_url: Override the default ``https://api.atlasent.io``.
        timeout: Per-request timeout in seconds. Defaults to 10s.
        client: Inject a custom ``httpx.Client`` (primarily for tests).

    The client owns its underlying ``httpx.Client``. Use as a context
    manager or call :meth:`close` when finished, mirroring v1 ergonomics.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        client: httpx.Client | None = None,
    ) -> None:
        if not api_key:
            raise V2Error("api_key is required", code="invalid_api_key")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._client = client or httpx.Client(
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"Bearer {api_key}",
                "User-Agent": "atlasent-v2-alpha-python/2.0.0a0",
            },
            timeout=timeout,
        )

    def __enter__(self) -> AtlaSentV2Client:
        return self

    def __exit__(self, *_exc_info: Any) -> None:
        self.close()

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def consume(
        self,
        permit_id: str,
        payload_hash: str,
        execution_status: Literal["executed", "failed"],
        *,
        execution_hash: str | None = None,
    ) -> ConsumeResponse:
        """Close a permit lifecycle by recording the wrapped callback's outcome.

        Mirrors ``POST /v2/permits/:id/consume``. The raw payload is
        never sent — only ``payload_hash`` (compute it via
        :func:`hash_payload`).
        """
        request = ConsumeRequest(
            permit_id=permit_id,
            payload_hash=payload_hash,
            execution_status=execution_status,
            execution_hash=execution_hash,
            api_key=self._api_key,
        )
        path = f"/v2/permits/{_quote(permit_id)}/consume"
        data = self._post(
            path,
            request.model_dump(by_alias=True, exclude_none=True),
        )
        return ConsumeResponse.model_validate(data)

    def evaluate_batch(
        self, requests: list[BatchEvaluateItem]
    ) -> EvaluateBatchResponse:
        """Batch evaluate. Mirrors ``POST /v2/evaluate:batch``.

        One HTTP call for N decisions, one rate-limit decrement, one
        hash-chain entry. Order is preserved: ``result.items[i]``
        decides ``requests[i]``.

        Raises :class:`V2Error` (``code='invalid_argument'``) when
        ``requests`` is empty or exceeds the wire-side cap of 1000.
        """
        if not isinstance(requests, list) or len(requests) == 0:
            raise V2Error("requests must be a non-empty list", code="invalid_argument")
        if len(requests) > 1000:
            raise V2Error(
                f"requests length {len(requests)} exceeds maximum of 1000",
                code="invalid_argument",
            )
        body = EvaluateBatchRequest(requests=requests, api_key=self._api_key)
        data = self._post(
            "/v2/evaluate:batch",
            body.model_dump(by_alias=True, exclude_none=True),
        )
        return EvaluateBatchResponse.model_validate(data)

    def verify_proof(self, proof_id: str) -> ProofVerificationResult:
        """Server-side proof verification.

        Mirrors ``POST /v2/proofs/:id/verify``. Returns the canonical
        :class:`ProofVerificationResult` that the offline CLI also
        produces — online and offline paths emit byte-identical output.
        """
        if not proof_id:
            raise V2Error("proof_id is required", code="invalid_argument")
        path = f"/v2/proofs/{_quote(proof_id)}/verify"
        data = self._post(path, {"api_key": self._api_key})
        return ProofVerificationResult.model_validate(data)

    def subscribe_decisions(
        self,
        *,
        last_event_id: str | None = None,
    ) -> Iterator[DecisionEvent]:
        """Subscribe to the v2 decision-event stream (Pillar 3).

        Yields one :class:`DecisionEvent` per server frame. Iterate
        with ``for event in client.subscribe_decisions():``.

        Reconnect: on disconnect, restart by passing the last seen
        ``event.id`` as ``last_event_id`` and the server replays from
        there.

        Cancel: stop iterating; the underlying httpx stream is closed
        when the generator is exhausted or garbage-collected.
        """
        url = f"{self._base_url}/v2/decisions:subscribe"
        headers = {
            "Accept": "text/event-stream",
            "Authorization": f"Bearer {self._api_key}",
            "User-Agent": "atlasent-v2-alpha-python/2.0.0a0",
        }
        if last_event_id:
            headers["Last-Event-ID"] = last_event_id

        try:
            with self._client.stream("GET", url, headers=headers) as response:
                if response.status_code == 401:
                    raise V2Error(
                        "Invalid API key",
                        status_code=401,
                        code="invalid_api_key",
                    )
                if not response.is_success:
                    raise V2Error(
                        f"API error {response.status_code} on /v2/decisions:subscribe",
                        status_code=response.status_code,
                        code="http_error",
                    )
                for frame in parse_sse_lines(response.iter_lines()):
                    if not frame.data:
                        continue
                    try:
                        payload = json.loads(frame.data)
                    except ValueError:
                        # Malformed JSON in a frame — skip rather than
                        # tear down the whole stream. Wire contract is
                        # JSON-per-frame.
                        continue
                    if isinstance(payload, dict):
                        yield DecisionEvent.model_validate(payload)
        except httpx.TimeoutException as exc:
            raise V2Error(
                f"Request to /v2/decisions:subscribe timed out after {self._timeout}s",
                code="timeout",
            ) from exc
        except httpx.ConnectError as exc:
            raise V2Error(f"Failed to connect to {url}: {exc}", code="network") from exc

    def _post(self, path: str, body: Any) -> Any:
        url = f"{self._base_url}{path}"
        try:
            response = self._client.post(url, json=body)
        except httpx.TimeoutException as exc:
            raise V2Error(
                f"Request to {path} timed out after {self._timeout}s",
                code="timeout",
            ) from exc
        except httpx.ConnectError as exc:
            raise V2Error(
                f"Failed to connect to {url}: {exc}",
                code="network",
            ) from exc

        body_text = response.text or ""
        parsed: Any = None
        if body_text:
            try:
                parsed = response.json()
            except ValueError:
                if response.is_success:
                    raise V2Error(
                        f"Malformed JSON in response from {path}",
                        status_code=response.status_code,
                        code="bad_response",
                    ) from None

        if not response.is_success:
            code = "invalid_api_key" if response.status_code == 401 else "http_error"
            message = (
                "Invalid API key"
                if response.status_code == 401
                else f"API error {response.status_code} on {path}"
            )
            raise V2Error(
                message,
                status_code=response.status_code,
                code=code,
                response_body=parsed if parsed is not None else body_text,
            )

        return parsed


def _quote(s: str) -> str:
    """URL-quote a path segment. Lazy import to avoid a hard urllib import."""
    from urllib.parse import quote

    return quote(s, safe="")
