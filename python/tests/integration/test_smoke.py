"""Staging smoke test — hits the real AtlaSent API.

Skipped unless ATLASENT_API_KEY is in the environment. Run via::

    ATLASENT_API_KEY=ask_staging_... \
    ATLASENT_BASE_URL=https://staging.atlasent.io \
    pytest tests/integration/ -m integration
"""

from __future__ import annotations

import os

import pytest

from atlasent import AtlaSentClient
from atlasent.exceptions import AtlaSentError

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.environ.get("ATLASENT_API_KEY"),
        reason="ATLASENT_API_KEY not set",
    ),
]


@pytest.fixture
def client() -> AtlaSentClient:
    return AtlaSentClient(
        api_key=os.environ["ATLASENT_API_KEY"],
        base_url=os.environ.get("ATLASENT_BASE_URL", "https://staging.atlasent.io"),
    )


def test_evaluate_roundtrip(client: AtlaSentClient) -> None:
    """Evaluate against staging; either it permits or it denies — both are fine.

    What we're checking is that the wire contract holds (no
    AtlaSentError, no bad_response) and the response has the fields
    the SDK expects.
    """
    try:
        result = client.evaluate(
            "integration_test",
            "sdk-ci-runner",
            {"ci": True, "repo": "atlasent-sdk"},
        )
    except AtlaSentError as exc:
        # A staging deny is fine. A transport/schema failure is not.
        assert (
            exc.code != "bad_response"
        ), f"bad_response from staging: {exc.response_body}"
        return
    assert isinstance(result.permit_token, str) and result.permit_token
