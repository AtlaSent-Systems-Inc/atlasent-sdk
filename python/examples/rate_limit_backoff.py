"""Rate-limit back-off example.

Shows how to use the ``rate_limit`` attribute returned on every authed
response (new in ``atlasent`` 1.3.0). Rather than hammering the
evaluate endpoint until it 429s, the client preemptively sleeps until
the next window when its budget gets tight.

Run with::

    export ATLASENT_API_KEY=ask_live_...
    python examples/rate_limit_backoff.py
"""

import os
import time
from datetime import datetime, timezone

from atlasent import AtlaSentClient, RateLimitState

api_key = os.environ.get("ATLASENT_API_KEY")
if not api_key:
    raise SystemExit("ATLASENT_API_KEY env var is required")

client = AtlaSentClient(api_key=api_key)


def should_back_off(rl: RateLimitState | None, min_remaining: int) -> bool:
    """Fall through to the client's own 429 handling when rate-limit
    state isn't reported — older server deployments or internal
    endpoints that skip per-key limits."""
    return rl is not None and rl.remaining < min_remaining


def evaluate_batch(actions: list[dict], min_remaining: int = 5) -> None:
    """Walk a batch of actions, sleeping until the next window when
    fewer than ``min_remaining`` tokens are left."""
    for i, req in enumerate(actions, start=1):
        result = client.evaluate(
            action_type=req["action"],
            actor_id=req["agent"],
            context=req.get("context", {}),
        )
        print(
            f"[{i}/{len(actions)}] {req['action']} → permitted={result.decision} "
            f"(token={result.permit_token})"
        )

        if should_back_off(result.rate_limit, min_remaining):
            assert result.rate_limit is not None  # for mypy; guard above proves it
            wait = (
                result.rate_limit.reset_at - datetime.now(timezone.utc)
            ).total_seconds()
            wait = max(0.0, wait)
            print(
                f"  …rate-limit low ({result.rate_limit.remaining} / "
                f"{result.rate_limit.limit}); sleeping {wait:.1f}s until reset"
            )
            time.sleep(wait)


evaluate_batch(
    [
        {"agent": "ci-bot", "action": "deploy_production", "context": {"commit": "abc123"}},
        {"agent": "ci-bot", "action": "deploy_staging", "context": {"commit": "abc123"}},
        {"agent": "ci-bot", "action": "run_integration_tests"},
    ]
)
