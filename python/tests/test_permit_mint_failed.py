"""Tests for the permit-mint operational-error taxonomy (atlasent-api #1634).

Policy evaluation resolving ALLOW but AtlaSent being unable to materialize
executable authority (the permit could not be minted/signed) is a distinct
operational/infrastructure failure — not a DENY, HOLD, or ESCALATE. This
must be structurally distinguishable (via ``isinstance``), not just by
inspecting a string field, matching how DENY/HOLD/ESCALATE are already
modeled and mirroring the TypeScript SDK's ``AtlaSentPermitMintFailedError``
(``atlasent-api`` ``packages/sdk/src/errors.ts``).

Two wire shapes both raise ``AtlaSentPermitMintFailedError``:

1. A non-2xx status (503 recoverable / 500 invariant) carrying
   ``{"error": "permit_signing_unavailable", ...}``.
2. A defensive fallback: a 2xx response with ``decision: "allow"`` but no
   ``permit_token``.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from atlasent import (
    AsyncAtlaSentClient,
    AtlaSentClient,
    AtlaSentDenied,
    AtlaSentError,
    AtlaSentPermitMintFailedError,
)


def _resp(
    mocker: Any,
    status_code: int = 200,
    json_data: Any | None = None,
    text: str = "",
) -> Any:
    r = mocker.Mock(spec=httpx.Response)
    r.status_code = status_code
    r.headers = {}
    r.text = text
    if json_data is not None:
        r.json.return_value = json_data
    return r


def _mint_failure_body(message: str = "signer unavailable") -> str:
    return json.dumps({"error": "permit_signing_unavailable", "message": message})


EVALUATE_ALLOW_MISSING_PERMIT_TOKEN = {"decision": "allow", "bundle_version": "v3"}


# ─── Sync client — wire-level 503/500 envelope ─────────────────────────


class TestSyncPermitMintFailure:
    def test_503_permit_signing_unavailable_raises_distinct_class(
        self, mocker: Any
    ) -> None:
        client = AtlaSentClient(api_key="ask_test_x", max_retries=0)
        resp = _resp(mocker, status_code=503, text=_mint_failure_body())
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(AtlaSentPermitMintFailedError) as exc_info:
            client.evaluate("ci.deploy", "bot")

        err = exc_info.value
        assert isinstance(err, AtlaSentError)  # still catchable as the base class
        assert err.code == "permit_signing_unavailable"
        assert err.status_code == 503
        assert err.decision == "allow"

    def test_500_permit_signing_unavailable_also_raises_distinct_class(
        self, mocker: Any
    ) -> None:
        # The architecture decision allows either status for a mint
        # failure (503 recoverable / 500 invariant) — both must classify
        # the same way.
        client = AtlaSentClient(api_key="ask_test_x", max_retries=0)
        resp = _resp(mocker, status_code=500, text=_mint_failure_body())
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(AtlaSentPermitMintFailedError):
            client.evaluate("ci.deploy", "bot")

    def test_mint_failure_is_not_instance_of_atlasent_denied(self, mocker: Any) -> None:
        # Load-bearing assertion: application code must be able to tell
        # "policy denied me" apart from "policy allowed, but AtlaSent
        # could not materialize executable authority."
        client = AtlaSentClient(api_key="ask_test_x", max_retries=0)
        resp = _resp(mocker, status_code=503, text=_mint_failure_body())
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(Exception) as exc_info:
            client.evaluate("ci.deploy", "bot")
        assert not isinstance(exc_info.value, AtlaSentDenied)

    def test_unrelated_5xx_error_still_raises_generic_atlasent_error(
        self, mocker: Any
    ) -> None:
        client = AtlaSentClient(api_key="ask_test_x", max_retries=0)
        resp = _resp(
            mocker,
            status_code=500,
            text=json.dumps({"error": "internal_error", "message": "boom"}),
        )
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(AtlaSentError) as exc_info:
            client.evaluate("ci.deploy", "bot")
        assert not isinstance(exc_info.value, AtlaSentPermitMintFailedError)
        assert exc_info.value.code == "server_error"

    def test_non_json_5xx_body_still_raises_generic_atlasent_error(
        self, mocker: Any
    ) -> None:
        # Regression guard: a gateway timeout page or other non-JSON body
        # must fall through to the pre-existing generic path, not crash
        # the mint-failure parser.
        client = AtlaSentClient(api_key="ask_test_x", max_retries=0)
        resp = _resp(mocker, status_code=500, text="<html>Bad Gateway</html>")
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(AtlaSentError) as exc_info:
            client.evaluate("ci.deploy", "bot")
        assert not isinstance(exc_info.value, AtlaSentPermitMintFailedError)

    def test_mint_failure_classification_only_applies_after_retries_exhausted(
        self, mocker: Any
    ) -> None:
        # A transient 503 that recovers on retry must still return
        # normally — the mint-failure classification only fires on the
        # terminal raise, mirroring how every other 5xx is already
        # retried before being raised.
        client = AtlaSentClient(
            api_key="ask_test_x", max_retries=1, retry_backoff=0.001
        )
        transient = _resp(mocker, status_code=503, text=_mint_failure_body())
        recovered = _resp(
            mocker,
            status_code=200,
            json_data={
                "decision": "allow",
                "permit_token": "pt_xyz",
                "reason": "ok",
                "audit_hash": "h",
                "timestamp": "2026-01-01T00:00:00Z",
            },
        )
        mocker.patch.object(client._client, "post", side_effect=[transient, recovered])
        result = client.evaluate("ci.deploy", "bot")
        assert result.permit_token == "pt_xyz"

    def test_2xx_allow_missing_permit_token_raises_distinct_class(
        self, mocker: Any
    ) -> None:
        client = AtlaSentClient(api_key="ask_test_x", max_retries=0)
        resp = _resp(
            mocker, status_code=200, json_data=EVALUATE_ALLOW_MISSING_PERMIT_TOKEN
        )
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(AtlaSentPermitMintFailedError) as exc_info:
            client.evaluate("ci.deploy", "bot")
        assert exc_info.value.decision == "allow"
        assert exc_info.value.code == "permit_signing_unavailable"

    def test_protect_propagates_mint_failure_unwrapped(self, mocker: Any) -> None:
        # protect()'s except clause catches only AtlaSentDenied — a mint
        # failure must NOT be silently coerced into AtlaSentDeniedError.
        client = AtlaSentClient(api_key="ask_test_x", max_retries=0)
        resp = _resp(mocker, status_code=503, text=_mint_failure_body())
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(AtlaSentPermitMintFailedError):
            client.protect(
                agent="bot", action="ci.deploy", context={"environment": "production"}
            )


# ─── Async client — same contract ──────────────────────────────────────


class TestAsyncPermitMintFailure:
    async def test_503_permit_signing_unavailable_raises_distinct_class(
        self, mocker: Any
    ) -> None:
        client = AsyncAtlaSentClient(api_key="ask_test_x", max_retries=0)
        resp = _resp(mocker, status_code=503, text=_mint_failure_body())
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(AtlaSentPermitMintFailedError) as exc_info:
            await client.evaluate("ci.deploy", "bot")
        assert exc_info.value.code == "permit_signing_unavailable"
        assert exc_info.value.status_code == 503

    async def test_2xx_allow_missing_permit_token_raises_distinct_class(
        self, mocker: Any
    ) -> None:
        client = AsyncAtlaSentClient(api_key="ask_test_x", max_retries=0)
        resp = _resp(
            mocker, status_code=200, json_data=EVALUATE_ALLOW_MISSING_PERMIT_TOKEN
        )
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(AtlaSentPermitMintFailedError):
            await client.evaluate("ci.deploy", "bot")

    async def test_unrelated_5xx_error_still_raises_generic_atlasent_error(
        self, mocker: Any
    ) -> None:
        client = AsyncAtlaSentClient(api_key="ask_test_x", max_retries=0)
        resp = _resp(
            mocker,
            status_code=500,
            text=json.dumps({"error": "internal_error"}),
        )
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(AtlaSentError) as exc_info:
            await client.evaluate("ci.deploy", "bot")
        assert not isinstance(exc_info.value, AtlaSentPermitMintFailedError)
