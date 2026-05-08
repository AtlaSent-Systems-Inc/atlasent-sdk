"""Webhook signature verification for AtlaSent.

AtlaSent signs webhook payloads with HMAC-SHA256 using your webhook signing
secret. The signature is sent in the ``X-AtlaSent-Signature`` header as
``"sha256=<hex>"``.

Parity with ``typescript/src/webhook.ts``.

Usage::

    from atlasent.webhook import verify_webhook, assert_webhook

    # Returns True/False — good for middleware that needs to continue on failure.
    valid = verify_webhook(raw_body, request.headers["x-atlasent-signature"], secret)

    # Raises WebhookVerificationError on failure — good for middleware that throws.
    assert_webhook(raw_body, request.headers["x-atlasent-signature"], secret)
"""

from __future__ import annotations

import hashlib
import hmac


class WebhookVerificationError(Exception):
    """Raised by :func:`assert_webhook` when the signature is missing,
    malformed, or does not match the payload.

    Parity with ``WebhookVerificationError`` in the TypeScript SDK.
    """


def verify_webhook(payload: str | bytes, signature: str, secret: str) -> bool:
    """Verify an AtlaSent webhook payload signature.

    AtlaSent signs webhook payloads with HMAC-SHA256.
    The signature is sent in the ``X-AtlaSent-Signature`` header as
    ``"sha256=<hex>"``.

    Args:
        payload: Raw request body (str or bytes). Pass the bytes **before**
            any JSON parsing — parsing may change whitespace and break the
            signature.
        signature: Value of the ``X-AtlaSent-Signature`` header, e.g.
            ``"sha256=abc123..."``.
        secret: Your webhook signing secret. Store as an environment variable;
            never log it.

    Returns:
        ``True`` if the signature is valid, ``False`` otherwise.
        **Always reject the payload when this returns** ``False``.

    Note:
        This function never raises — malformed or missing signatures return
        ``False``. Use :func:`assert_webhook` if you prefer exception-based
        control flow.

    Examples:
        FastAPI::

            from fastapi import FastAPI, Request, HTTPException
            from atlasent import verify_webhook

            @app.post("/webhooks/atlasent")
            async def handle(request: Request):
                raw = await request.body()
                sig = request.headers.get("x-atlasent-signature", "")
                if not verify_webhook(raw, sig, WEBHOOK_SECRET):
                    raise HTTPException(401, "Invalid signature")
                ...
    """
    try:
        if not signature.startswith("sha256="):
            return False
        received_hex = signature[len("sha256="):]

        payload_bytes: bytes = (
            payload if isinstance(payload, bytes) else payload.encode("utf-8")
        )
        expected_hex = hmac.new(
            secret.encode("utf-8"), payload_bytes, hashlib.sha256
        ).hexdigest()

        return hmac.compare_digest(expected_hex, received_hex)
    except Exception:  # noqa: BLE001
        return False


def assert_webhook(payload: str | bytes, signature: str, secret: str) -> None:
    """Like :func:`verify_webhook` but raises :exc:`WebhookVerificationError`
    on failure instead of returning ``False``.

    Useful in middleware where throwing is cleaner than inspecting a boolean
    return value.

    Args:
        payload: Raw request body (str or bytes).
        signature: Value of the ``X-AtlaSent-Signature`` header.
        secret: Your webhook signing secret.

    Raises:
        WebhookVerificationError: If the signature is invalid or malformed.
    """
    if not verify_webhook(payload, signature, secret):
        raise WebhookVerificationError(
            "Webhook signature verification failed: "
            "the signature does not match the payload."
        )
