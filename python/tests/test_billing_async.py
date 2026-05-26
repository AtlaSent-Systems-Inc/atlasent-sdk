"""Async coverage tests for atlasent.billing."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from atlasent.billing import (
    AdminOverrideRequest,
    AsyncBillingClient,
    BillingEntitlement,
)

_NOW = "2026-05-08T00:00:00Z"


def _async_billing_client(get_payload: dict, post_payload: dict | None = None):
    resp_get = MagicMock(spec=httpx.Response)
    resp_get.raise_for_status.return_value = None
    resp_get.json.return_value = get_payload

    resp_post = MagicMock(spec=httpx.Response)
    resp_post.raise_for_status.return_value = None
    resp_post.json.return_value = post_payload or get_payload

    resp_delete = MagicMock(spec=httpx.Response)
    resp_delete.raise_for_status.return_value = None

    http_client = MagicMock()
    http_client.get = AsyncMock(return_value=resp_get)
    http_client.post = AsyncMock(return_value=resp_post)
    http_client.delete = AsyncMock(return_value=resp_delete)

    root = MagicMock()
    root._client = http_client
    root._base_url = "https://api.example.com"
    return AsyncBillingClient(root), root


@pytest.mark.asyncio
async def test_async_get_entitlement_and_set_clear_override() -> None:
    ent_payload = {
        "org_id": "org_1",
        "access_status": "active",
        "effective_status": "active",
        "allowed_actions": ["govern"],
        "computed_at": _NOW,
    }
    override_payload = {
        "org_id": "org_1",
        "new_status": "grace",
        "override_active": True,
        "override_status": "grace",
    }
    client, raw = _async_billing_client(ent_payload, override_payload)

    ent = await client.get_entitlement(org_id="org_1")
    assert isinstance(ent, BillingEntitlement)
    assert ent.org_id == "org_1"

    req = AdminOverrideRequest(org_id="org_1", status="grace", reason="ticket")
    resp = await client.set_override(req)
    assert resp.override_active is True

    cleared = await client.clear_override("org_1", reason="done")
    assert cleared.org_id == "org_1"

    post_json = raw._client.post.call_args.kwargs["json"]
    assert "status" not in post_json


@pytest.mark.asyncio
async def test_async_webhook_subscription_methods() -> None:
    list_payload = {
        "subscriptions": [
            {
                "id": "wh_1",
                "org_id": "org_1",
                "url": "https://hooks.example.com",
                "events": ["billing.access_changed"],
                "active": True,
                "created_at": _NOW,
            }
        ]
    }
    create_payload = {
        "id": "wh_2",
        "org_id": "org_1",
        "url": "https://hooks2.example.com",
        "events": ["billing.access_changed"],
        "active": True,
        "created_at": _NOW,
        "secret": "sec",
    }
    client, raw = _async_billing_client(list_payload, create_payload)

    listed = await client.list_webhook_subscriptions(org_id="org_1")
    assert len(listed) == 1
    assert listed[0].id == "wh_1"

    created = await client.create_webhook_subscription(
        "https://hooks2.example.com",
        ["billing.access_changed"],
        org_id="org_1",
    )
    assert created.id == "wh_2"

    await client.delete_webhook_subscription("wh_2")
    assert raw._client.delete.call_count == 1
