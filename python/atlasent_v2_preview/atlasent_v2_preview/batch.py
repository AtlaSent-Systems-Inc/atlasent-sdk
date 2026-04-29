"""v2 Pillar 2 — Batch evaluation models + builders.

Python sibling of ``typescript/packages/v2-preview/src/batch.ts``
plus ``buildBatch.ts``. Pure data — no HTTP. The v2-preview package
stays HTTP-free; these helpers let callers wire their own httpx /
requests client with consistent shape checking.

Per-item response is a discriminated union on ``permitted``:
``BatchEvaluateAllowItem`` carries the allow shape;
``BatchEvaluateDenyItem`` is the deny shape. ``isinstance()``
narrows in the same way TypeScript narrows on the ``permitted``
literal.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

EVALUATE_BATCH_MAX_ITEMS = 1000
"""Maximum items in a single batch — matches the schema's ``maxItems``."""


BatchProofStatus = Literal["pending", "executed", "failed", "not_applicable"]
"""Pillar 9 proof status reported on a batch item that opted in via ``payload_hash``."""


_HASH_HEX = re.compile(r"^[0-9a-f]{64}$")


class BatchEvaluateItem(BaseModel):
    """One inbound evaluate request inside a batch.

    See ``contract/schemas/v2/evaluate-batch-request.schema.json``
    ``$defs.BatchEvaluateItem``.
    """

    action: str = Field(min_length=1, max_length=256)
    agent: str = Field(min_length=1, max_length=256)
    context: dict[str, Any] = Field(default_factory=dict)
    payload_hash: str | None = Field(default=None)
    """Optional client-side payload hash. Opt-in to the Pillar 9 proof flow."""

    target: str | None = None
    """Optional target resource identifier. Mirrors ``Proof.target``."""

    model_config = {"extra": "allow"}

    @model_validator(mode="after")
    def _validate_payload_hash(self) -> BatchEvaluateItem:
        if self.payload_hash is not None and not _HASH_HEX.match(self.payload_hash):
            raise ValueError(
                "payload_hash must be 64 lowercase hex chars"
            )
        return self


class EvaluateBatchRequest(BaseModel):
    """Request body for ``POST /v2/evaluate:batch``.

    See ``contract/schemas/v2/evaluate-batch-request.schema.json``.
    """

    requests: list[BatchEvaluateItem] = Field(
        min_length=1, max_length=EVALUATE_BATCH_MAX_ITEMS
    )
    api_key: str = Field(min_length=1)

    model_config = {"extra": "forbid"}


class _ResponseItemBase(BaseModel):
    """Common fields every per-item response carries.

    ``permitted`` discriminates allow vs. deny.
    """

    index: int = Field(ge=0)
    decision_id: str
    reason: str = ""
    audit_hash: str
    timestamp: str
    batch_id: str
    proof_id: str | None = None
    proof_status: BatchProofStatus | None = None

    model_config = {"extra": "allow"}


class BatchEvaluateAllowItem(_ResponseItemBase):
    """Per-item response when ``permitted is True``."""

    permitted: Literal[True]


class BatchEvaluateDenyItem(_ResponseItemBase):
    """Per-item response when ``permitted is False``."""

    permitted: Literal[False]


BatchEvaluateResponseItem = BatchEvaluateAllowItem | BatchEvaluateDenyItem
"""Discriminated union — narrow via ``isinstance()`` on either variant."""


class EvaluateBatchResponse(BaseModel):
    """Response body for ``POST /v2/evaluate:batch``.

    See ``contract/schemas/v2/evaluate-batch-response.schema.json``.
    """

    batch_id: str = Field(min_length=1)
    items: list[BatchEvaluateAllowItem | BatchEvaluateDenyItem] = Field(
        default_factory=list
    )

    model_config = {"extra": "allow"}


# ── Builders ─────────────────────────────────────────────────────────


def build_evaluate_batch_request(
    items: list[BatchEvaluateItem | dict[str, Any]],
    api_key: str,
) -> EvaluateBatchRequest:
    """Construct a wire-valid :class:`EvaluateBatchRequest`.

    Accepts either fully-validated :class:`BatchEvaluateItem` instances
    or raw dicts (validated on the way in). Raises :class:`ValueError`
    on size or shape violations — the SDK boundary should catch them
    before sending an obviously malformed batch.
    """
    if not items:
        raise ValueError(
            "build_evaluate_batch_request: requests must contain at least 1 item"
        )
    if len(items) > EVALUATE_BATCH_MAX_ITEMS:
        raise ValueError(
            f"build_evaluate_batch_request: requests exceeds max "
            f"{EVALUATE_BATCH_MAX_ITEMS} (got {len(items)})"
        )
    if not isinstance(api_key, str) or not api_key:
        raise ValueError(
            "build_evaluate_batch_request: api_key must be a non-empty string"
        )
    cleaned: list[BatchEvaluateItem] = []
    for i, item in enumerate(items):
        if isinstance(item, BatchEvaluateItem):
            cleaned.append(item)
            continue
        try:
            cleaned.append(BatchEvaluateItem.model_validate(item))
        except Exception as err:
            raise ValueError(
                f"build_evaluate_batch_request: items[{i}] failed validation: {err}"
            ) from err
    return EvaluateBatchRequest(requests=cleaned, api_key=api_key)


def parse_evaluate_batch_response(body: Any) -> EvaluateBatchResponse:
    """Validate + narrow a server response body.

    Lifts the per-item discriminated union into the type system so
    callers can ``isinstance(item, BatchEvaluateAllowItem)`` /
    ``BatchEvaluateDenyItem`` without unsafe casts. Raises
    :class:`ValueError` on structural violations.
    """
    if not isinstance(body, dict):
        raise ValueError(
            "parse_evaluate_batch_response: body must be a JSON object"
        )
    try:
        return EvaluateBatchResponse.model_validate(body)
    except Exception as err:
        raise ValueError(
            f"parse_evaluate_batch_response: invalid response body: {err}"
        ) from err
