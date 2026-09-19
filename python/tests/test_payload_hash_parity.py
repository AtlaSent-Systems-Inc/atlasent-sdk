"""Cross-repo parity gate for the execution-payload digest (Python side).

WHY THIS FILE EXISTS. ``protect()`` and ``with_permit()`` present a digest at
verify that ``/v1-verify-permit`` compares against whatever the permit was
bound to at evaluate time, folding case and normalizing nothing else. For the
whole life of that code the SDK returned BARE hex while the server's
``hashPayload`` returns ``"sha256:" + hex``, so the two could never compare
equal: a deterministic ``PAYLOAD_MISMATCH`` on every call against a runtime
that populates the binding — which ``v1-evaluate`` does unconditionally.

Nothing caught it. The two tests that existed over the old helper
(``tests/test_with_permit_hash.py``) asserted that it was deterministic for
reordered payloads and that it changed when the payload changed. Both are true
of the broken version. Determinism and sensitivity are not parity, and no test
in either repo compared the two implementations.

So this file pins BOTH halves, and neither alone is enough:

* A vendored reference copy of the server function, so a change to this SDK's
  canonicalization fails here rather than in a customer's audit.
* Committed golden digests generated from the real server source, so the
  vendored copy cannot be edited into agreement with a broken SDK.

The goldens are the SAME values the TypeScript SDK pins in
``typescript/test/payload-hash-parity.test.ts``, which makes this a
three-implementation gate: server TS, SDK TS, SDK Python.

Regenerate only alongside a deliberate, reviewed canonical-form change on every
side — a chain version bump, in the language ``atlasent-verify`` uses for the
same rule.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import pytest

from atlasent.exceptions import AtlaSentError
from atlasent.payload_hash import (
    canonicalize_payload,
    is_bare_payload_hash,
    normalize_caller_payload_hash,
    server_payload_hash,
)


# ---------------------------------------------------------------------------
# Vendored REFERENCE implementation.
#
# Verbatim behaviour of atlasent-api supabase/functions/_shared/canonical.ts
# (`canonicalize` + `hashPayload`). Deliberately a second copy and not an
# import: the server file is Deno TypeScript in another repository. Keep it in
# lock-step with the original.
# ---------------------------------------------------------------------------
def _reference_canonicalize(value: Any) -> str:
    if value is None or not isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(_reference_canonicalize(v) for v in value) + "]"
    entries = [
        json.dumps(k, separators=(",", ":"), ensure_ascii=False)
        + ":"
        + _reference_canonicalize(value[k])
        for k in sorted(value.keys())
    ]
    return "{" + ",".join(entries) + "}"


def _reference_hash_payload(payload: Any) -> str:
    digest = hashlib.sha256(
        _reference_canonicalize(payload).encode("utf-8")
    ).hexdigest()
    return f"sha256:{digest}"


def _pre_fix_hash(payload: Any) -> str:
    """The digest this SDK produced BEFORE the fix: same bytes, no prefix.

    Kept so the defect can be stated precisely — the material agreed, the form
    did not — and so a regression back to bare hex is caught by name.
    """

    def sort_deep(obj: Any) -> Any:
        if isinstance(obj, dict):
            return {k: sort_deep(v) for k, v in sorted(obj.items())}
        if isinstance(obj, list):
            return [sort_deep(i) for i in obj]
        return obj

    canonical = json.dumps(
        sort_deep(payload), separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Vectors + committed goldens.
#
# Eight of the TypeScript suite's ten. The two omitted ones cover JavaScript's
# `undefined` — dropped from an object, coerced to null in an array — which
# Python cannot express, so there is no Python-side behaviour to pin.
# ---------------------------------------------------------------------------
VECTORS: dict[str, Any] = {
    "minimal": {"action_type": "tools.search", "actor_id": "agent-1", "context": {}},
    "nested": {
        "action_type": "tools.write_file",
        "actor_id": "agent-7",
        "context": {
            "environment": "production",
            "input": {"path": "/etc/x", "body": "hello"},
            "session": "s1",
        },
    },
    "keyorder": {"context": {"b": 1, "a": 2}, "actor_id": "a", "action_type": "t"},
    "unicode": {
        "action_type": "tools.send",
        "actor_id": "agent-é",
        "context": {"input": "café — naïve \U0001f680"},
    },
    "arrays": {
        "action_type": "t",
        "actor_id": "a",
        "context": {"xs": [3, 1, {"z": 1, "y": 2}, None]},
    },
    "numerics": {
        "action_type": "t",
        "actor_id": "a",
        "context": {"i": 1, "f": 1.5, "neg": -0.25, "big": 1e21, "zero": 0},
    },
    "emptyish": {
        "action_type": "t",
        "actor_id": "a",
        "context": {"s": "", "o": {}, "arr": [], "n": None, "t": True},
    },
    "escapes": {
        "action_type": "t",
        "actor_id": "a",
        "context": {"s": 'line\nbreak\t"quote"\\slash'},
    },
}

# Bare hex, exactly as generated from the real server source. The scheme
# prefix is applied once, below, so it is visible in code rather than repeated
# into eight over-long literals — and so a change to it is a one-line diff.
GOLDEN_HEX: dict[str, str] = {
    "minimal": "8b873b92e37bacd9176d5c9e9074ba6dfc227b0cad3ceb5f6c3f9bd30e4e8c32",
    "nested": "3a3ec3cfa7f4db281cdc331ded08a277aa9606a784652fc8853dfc7e422012ba",
    "keyorder": "bc41c755b04990b48e2abd533eb49d0db57cf4cf8b427d35df67ad58c0868287",
    "unicode": "3d539d6a1abe779bdbd1898a206b920775a77a3324c8532f68066b0bc39f20ed",
    "arrays": "a84cec3c6bab38cace05ade5c3dc7e3f99a36110d8e02d646182f179dd62fe21",
    "numerics": "2b89d8ec3e76e520457dda2bf23231c8e3d2dd3dc70520334bb6fc128a485d7b",
    "emptyish": "cbdcfb3f3883c17ca155e4f236149d8e4697dc372e1930b3ba746d7dd6471055",
    "escapes": "14c97bf5e53053c2c65c8be39fdb1cc255fe97769694fb756407eb813c54763e",
}

GOLDEN_SERVER_HASH: dict[str, str] = {
    name: f"sha256:{digest}" for name, digest in GOLDEN_HEX.items()
}

GOLDEN_CANONICAL: dict[str, str] = {
    "minimal": '{"action_type":"tools.search","actor_id":"agent-1","context":{}}',
    "keyorder": '{"action_type":"t","actor_id":"a","context":{"a":2,"b":1}}',
    "numerics": (
        '{"action_type":"t","actor_id":"a",'
        '"context":{"big":1e+21,"f":1.5,"i":1,"neg":-0.25,"zero":0}}'
    ),
    "emptyish": (
        '{"action_type":"t","actor_id":"a",'
        '"context":{"arr":[],"n":null,"o":{},"s":"","t":true}}'
    ),
    "escapes": (
        '{"action_type":"t","actor_id":"a",'
        '"context":{"s":"line\\nbreak\\t\\"quote\\"\\\\slash"}}'
    ),
}

VECTOR_NAMES = sorted(VECTORS)


def test_every_vector_has_a_golden() -> None:
    # A parity gate that silently stops covering a shape is the failure mode
    # that produced the defect. Assert the census.
    assert len(VECTOR_NAMES) == 8
    for name in VECTOR_NAMES:
        assert name in GOLDEN_SERVER_HASH, f"no golden for vector {name!r}"


@pytest.mark.parametrize("name", VECTOR_NAMES)
def test_canonical_bytes_match_vendored_server_reference(name: str) -> None:
    assert canonicalize_payload(VECTORS[name]) == _reference_canonicalize(VECTORS[name])


@pytest.mark.parametrize("name", VECTOR_NAMES)
def test_hash_matches_vendored_server_reference(name: str) -> None:
    assert server_payload_hash(VECTORS[name]) == _reference_hash_payload(VECTORS[name])


@pytest.mark.parametrize("name", VECTOR_NAMES)
def test_hash_matches_committed_golden_from_real_server_source(name: str) -> None:
    assert server_payload_hash(VECTORS[name]) == GOLDEN_SERVER_HASH[name]


@pytest.mark.parametrize("name", sorted(GOLDEN_CANONICAL))
def test_canonical_bytes_match_committed_golden_bytes(name: str) -> None:
    assert canonicalize_payload(VECTORS[name]) == GOLDEN_CANONICAL[name]


@pytest.mark.parametrize("name", VECTOR_NAMES)
def test_carries_the_sha256_scheme_prefix(name: str) -> None:
    # Stated as its own assertion rather than left implicit in the goldens,
    # because this single missing prefix denied every protect() call.
    value = server_payload_hash(VECTORS[name])
    assert value.startswith("sha256:"), f"vector {name!r} lost its prefix"
    assert is_bare_payload_hash(value[len("sha256:") :])


@pytest.mark.parametrize("name", VECTOR_NAMES)
def test_differs_from_pre_fix_form_only_by_the_prefix(name: str) -> None:
    # The precise shape of the defect: correct material, wrong form. If these
    # ever differ by more than the prefix, the canonicalization itself has
    # drifted and the goldens above are what to trust.
    fixed = server_payload_hash(VECTORS[name])
    assert fixed == f"sha256:{_pre_fix_hash(VECTORS[name])}"
    assert fixed != _pre_fix_hash(VECTORS[name])


def test_python_and_typescript_goldens_are_the_same_values() -> None:
    # Documents the intent of this file: these constants are not
    # independently-derived Python expectations, they are the server's values,
    # shared verbatim with the TypeScript suite.
    assert GOLDEN_SERVER_HASH["minimal"] == ("sha256:" + GOLDEN_HEX["minimal"])
    assert (
        GOLDEN_HEX["minimal"]
        == "8b873b92e37bacd9176d5c9e9074ba6dfc227b0cad3ceb5f6c3f9bd30e4e8c32"
    )


def test_distinguishes_payloads_differing_only_past_a_truncation_point() -> None:
    # A digest over a truncated preview cannot detect a change beyond the
    # cutoff, which is why a guard must hash the full tool input.
    prefix = "x" * 600
    a = {"action_type": "t", "actor_id": "a", "context": {"input": prefix + "alpha"}}
    b = {"action_type": "t", "actor_id": "a", "context": {"input": prefix + "omega"}}
    assert server_payload_hash(a) != server_payload_hash(b)


def test_order_independent_over_keys_but_not_over_array_elements() -> None:
    k1 = {"action_type": "t", "actor_id": "a", "context": {"a": 1, "b": 2}}
    k2 = {"action_type": "t", "actor_id": "a", "context": {"b": 2, "a": 1}}
    assert server_payload_hash(k1) == server_payload_hash(k2)

    a1 = {"action_type": "t", "actor_id": "a", "context": {"xs": [1, 2]}}
    a2 = {"action_type": "t", "actor_id": "a", "context": {"xs": [2, 1]}}
    assert server_payload_hash(a1) != server_payload_hash(a2)


def test_non_ascii_is_not_escaped() -> None:
    # ensure_ascii=False is load-bearing: the server's JSON.stringify emits
    # non-ASCII literally, so escaping to \\uXXXX here would change every
    # digest over a payload containing one.
    assert "é" in canonicalize_payload({"k": "café"})
    assert "\\u00e9" not in canonicalize_payload({"k": "café"})


# ── normalize_caller_payload_hash ──────────────────────────────────────────

HEX = "a" * 64


def test_normalize_passes_through_bare_lowercase_hex() -> None:
    assert normalize_caller_payload_hash(HEX) == HEX


def test_normalize_lowercases_because_the_server_binds_the_lowered_value() -> None:
    assert normalize_caller_payload_hash("A" * 64) == HEX


def test_normalize_strips_a_sha256_prefix() -> None:
    # The runtime's bare-hex gate rejects the prefixed form and then DROPS it:
    # allow, permit, 200, no error, no binding. Stripping here is what makes
    # the common OCI / sha256sum form usable instead of silently inert.
    assert normalize_caller_payload_hash(f"sha256:{HEX}") == HEX
    assert normalize_caller_payload_hash(f"SHA256:{HEX.upper()}") == HEX


@pytest.mark.parametrize(
    "bad",
    ["", "not-a-hash", "a" * 63, "a" * 65, "sha256:" + "z" * 64, "sha256:", HEX[:32]],
)
def test_normalize_raises_rather_than_forwarding_a_droppable_digest(bad: str) -> None:
    with pytest.raises(AtlaSentError):
        normalize_caller_payload_hash(bad)


def test_normalize_rejects_non_strings() -> None:
    with pytest.raises(AtlaSentError):
        normalize_caller_payload_hash(None)  # type: ignore[arg-type]


def test_normalize_splits_on_the_first_colon_like_the_typescript_sdk() -> None:
    # TS uses indexOf(":"); rpartition would disagree here, and a silent
    # cross-language divergence is exactly what this module exists to stop.
    with pytest.raises(AtlaSentError):
        normalize_caller_payload_hash(f"sha256:extra:{HEX}")


def test_normalize_error_names_the_failure_well_enough_to_act_on() -> None:
    with pytest.raises(AtlaSentError, match="64 hex characters"):
        normalize_caller_payload_hash("nope")


def test_is_bare_payload_hash_rejects_the_prefixed_form() -> None:
    assert is_bare_payload_hash(HEX)
    assert is_bare_payload_hash("A" * 64)
    assert not is_bare_payload_hash(f"sha256:{HEX}")
    assert not is_bare_payload_hash(None)
    assert not is_bare_payload_hash(123)
    assert not is_bare_payload_hash("a" * 63)
