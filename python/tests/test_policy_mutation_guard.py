"""ADR-0002 invariant I-6: SDK has no governance-policy mutation methods.

Linked: atlasent-internal/architecture/ADR-0002, atlasent-sdk#230.

The artifact this guards is the policy in the ``policies`` /
``policy_versions`` tables, governed by the ``v1-policy-lifecycle`` edge
function and addressable under ``/v1/policies/*``. V3 governance lifecycle
deliberately keeps the write path Console-only and control-plane-only.

SCOPING NOTE: ``connector_enforcement_policies`` (per-connector rate limits
and IP allow-lists) is a DIFFERENT artifact and is OUT OF SCOPE for I-6.
The denylist below is written to exclude it by requiring a bare ``polic(y|ies)``
token rather than ``enforcement_polic(y|ies)``. The Python SDK today has no
methods on either artifact; this test guards against future drift.
"""

from __future__ import annotations

import inspect
import re

import pytest

from atlasent.async_client import AsyncAtlaSentClient
from atlasent.client import AtlaSentClient

POLICY_MUTATION_PATTERNS: tuple[re.Pattern[str], ...] = (
    # Bare mutation verbs immediately followed by polic(y|ies), optionally
    # with a _version(s) suffix. Catches create_policy, update_policy,
    # publish_policy, upsert_policy, create_policy_version. Misses (correctly):
    # upsert_enforcement_policy, list_enforcement_policies.
    re.compile(
        r"^(create|update|delete|publish|approve|vote|submit|upsert)_polic(y|ies)(_version|_versions)?$"
    ),
    # Anything namespaced under policy lifecycle.
    re.compile(r"^policy_?lifecycle"),
    # Explicit governance-policy qualifier (future namespace).
    re.compile(
        r"^(create|update|delete|publish|approve|vote|submit|upsert).*governance_polic(y|ies)"
    ),
)


def _public_methods(cls: type) -> list[str]:
    return [
        name
        for name, _ in inspect.getmembers(cls, predicate=inspect.isfunction)
        if not name.startswith("_")
    ]


def _is_policy_mutation(name: str) -> bool:
    return any(p.match(name) for p in POLICY_MUTATION_PATTERNS)


@pytest.mark.parametrize("client_cls", [AtlaSentClient, AsyncAtlaSentClient])
def test_client_has_no_policy_mutation_methods(client_cls: type) -> None:
    methods = _public_methods(client_cls)
    violations = [name for name in methods if _is_policy_mutation(name)]
    assert violations == [], (
        f"{client_cls.__name__} must not expose policy-mutation methods. "
        f"Found: {violations}. See ADR-0002 invariant I-6 in atlasent-internal."
    )


@pytest.mark.parametrize(
    "name",
    [
        "create_policy",
        "update_policy",
        "delete_policy",
        "publish_policy",
        "submit_policy",
        "vote_policy",
        "approve_policy",
        "upsert_policy",
        "create_policy_version",
        "update_policy_versions",
        "policy_lifecycle_submit",
        "policy_lifecycle_vote",
        "create_governance_policy",
        "publish_governance_policies",
    ],
)
def test_denylist_blocks_mutation_shapes(name: str) -> None:
    assert _is_policy_mutation(name), f"{name} should be blocked"


@pytest.mark.parametrize(
    "name",
    [
        "get_policy",
        "list_policies",
        "get_policy_version",
        "list_policy_versions",
        "evaluate",
        "verify_permit",
        # Out of scope (different artifact: per-connector enforcement settings)
        "upsert_enforcement_policy",
        "list_enforcement_policies",
    ],
)
def test_allowlist_permits_read_and_out_of_scope(name: str) -> None:
    assert not _is_policy_mutation(name), f"{name} should not be blocked"
