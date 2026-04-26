"""Pillar 9 primitives — canonical JSON + SHA-256 hashing.

Demonstrates that:
  1. ``canonicalize_payload`` produces deterministic byte output —
     sorted keys at every depth, no whitespace, escapes.
  2. ``hash_payload`` is the SHA-256 of that canonical output —
     the same hash the server will compute on its side, so the
     raw payload never has to leave the client.

Run:  python examples/01_canonicalize_and_hash.py
"""

from atlasent_v2_preview import canonicalize_payload, hash_payload


# Two structurally identical payloads with different key order.
a = {"commit": "abc123", "env": "prod", "approver": "sre@example.com"}
b = {"approver": "sre@example.com", "env": "prod", "commit": "abc123"}

# Canonical output is byte-identical regardless of input key order.
canonical_a = canonicalize_payload(a)
canonical_b = canonicalize_payload(b)
print(f"canonical(a): {canonical_a}")
print(f"canonical(b): {canonical_b}")
print(f"byte-equal?   {canonical_a == canonical_b}")  # True

# And so are their hashes — the only thing the v2 protect() flow
# actually sends to the server.
print(f"hash(a): {hash_payload(a)}")
print(f"hash(b): {hash_payload(b)}")

# Nested objects, arrays, unicode, nulls — all canonicalize the same
# way they would in TypeScript or Go.
complex_value = {
    "zebra": ["last", "in", "iter", "but", "not", "in", "output"],
    "alpha": {"nested": {"z": 3, "a": 1}, "漢": None},
    "null_field": None,
}
print()
print("complex canonical:")
print(canonicalize_payload(complex_value))
