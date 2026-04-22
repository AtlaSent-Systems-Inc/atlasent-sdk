"""Staging smoke test -- hits the real AtlaSent API.

Skipped unless ``ATLASENT_API_KEY`` is in the environment. Run via::

    ATLASENT_API_KEY=ak_staging_... \\
    ATLASENT_BASE_URL=https://api.staging.atlasent.io \\
    pytest tests/integration/ -m integration
"""

from __future__ import annotations

import os

import pytest

from atlasent import AtlaSentClient, EvaluateRequest
from atlasent.exceptions import AuthorizationUnavailableError

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
        base_url=os.environ.get("ATLASENT_BASE_URL", "https://api.staging.atlasent.io"),
    )


def test_evaluate_roundtrip(client: AtlaSentClient) -> None:
    """Evaluate against staging; either allow or deny is fine.

    What we're checking is that the wire contract holds -- no
    :class:`AuthorizationUnavailableError` from a malformed body, and the
    response carries the fields the SDK expects.
    """
    try:
        response = client.evaluate(
            EvaluateRequest(
                action_type="integration_test",
                actor_id="sdk-ci-runner",
                context={"ci": True, "repo": "atlasent-sdk"},
            )
        )
    except AuthorizationUnavailableError as exc:
        pytest.fail(f"transport-level failure against staging: {exc}")

    assert response.decision in {"allow", "deny", "hold", "escalate"}
    assert isinstance(response.request_id, str) and response.request_id
    assert response.mode in {"live", "shadow"}
    if response.decision == "allow":
        assert (
            isinstance(response.permit_token, str) and response.permit_token
        ), "allow must carry a permit_token"
