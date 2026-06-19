"""Structural type for the sync transport the flat helper modules depend on.

The standalone helper modules (``scim``, ``siem``, ``evidence_exports``) only
need a client with ``_base_url`` and an httpx ``_client``. Typing their
``client`` parameter against this ``Protocol`` — instead of importing the
concrete :class:`~atlasent.client.AtlaSentClient` — keeps those modules free of
any import of ``.client``. That matters because ``client.py`` imports the
helpers; importing ``.client`` back from the helpers would form an import cycle
(flagged by CodeQL ``py/cyclic-import``). ``AtlaSentClient`` satisfies this
Protocol structurally, so callers are unaffected.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    import httpx


class SyncTransport(Protocol):
    """Minimal synchronous-client surface used by the flat helper functions."""

    _base_url: str
    _client: httpx.Client
