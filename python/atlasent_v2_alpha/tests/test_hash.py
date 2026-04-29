"""Hash test suite.

Assertions: ``hash_payload`` returns 64-char lowercase hex, is
deterministic across key order, and — critically — hashes the same
bytes that ``canonicalize_payload`` emits so the client- and
server-side proof hashes agree.
"""

from __future__ import annotations

import hashlib
import math
import re

from atlasent_v2_alpha.canonicalize import canonicalize_payload
from atlasent_v2_alpha.hash import hash_payload

HEX_64 = re.compile(r"^[0-9a-f]{64}$")


def _sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


class TestHashPayload:
    def test_returns_64_char_lowercase_hex(self):
        assert HEX_64.match(hash_payload({"a": 1}))

    def test_deterministic_on_object_key_order(self):
        assert hash_payload({"a": 1, "b": 2}) == hash_payload({"b": 2, "a": 1})

    def test_differs_when_nested_value_changes(self):
        assert hash_payload({"a": {"b": 1}}) != hash_payload({"a": {"b": 2}})

    def test_equals_sha256_of_canonicalize_output(self):
        payload = {
            "commit": "abc123",
            "approver": "dr_smith",
            "env": "production",
            "meta": {"ts": "2026-04-24T00:00:00Z"},
        }
        assert hash_payload(payload) == _sha256_hex(canonicalize_payload(payload))

    def test_fixture_empty_object(self):
        # Locked-in: sha256("{}"). A change here surfaces any
        # inadvertent shift in the primitive rather than silently
        # re-hashing.
        assert hash_payload({}) == _sha256_hex("{}")

    def test_fixture_null(self):
        assert hash_payload(None) == _sha256_hex("null")

    def test_nan_and_inf_hash_same_as_null(self):
        null_hash = hash_payload(None)
        assert hash_payload(math.nan) == null_hash
        assert hash_payload(math.inf) == null_hash
        assert hash_payload(-math.inf) == null_hash
