"""Byte-equivalence tests for atlasent.governance._canonical.

Each case here MUST also pass in the TS test
``typescript/test/governance/canonicalCompat.test.ts``. These two test
files share the contract; the fixture in
``python/tests/governance/fixtures/parity.json`` is the cross-language
source of truth.
"""

from __future__ import annotations

import math

from atlasent.governance import canonicalize_for_evidence


def test_none_renders_as_null() -> None:
    assert canonicalize_for_evidence(None) == "null"


def test_booleans() -> None:
    assert canonicalize_for_evidence(True) == "true"
    assert canonicalize_for_evidence(False) == "false"
    # bool must NOT be encoded as int
    assert canonicalize_for_evidence(True) != "1"


def test_integers() -> None:
    assert canonicalize_for_evidence(0) == "0"
    assert canonicalize_for_evidence(42) == "42"
    assert canonicalize_for_evidence(-7) == "-7"
    assert canonicalize_for_evidence(1_000_000) == "1000000"


def test_whole_number_floats_elide_dot_zero() -> None:
    # Critical for byte-equivalence with TS String(1.0) === "1".
    assert canonicalize_for_evidence(1.0) == "1"
    assert canonicalize_for_evidence(0.0) == "0"
    assert canonicalize_for_evidence(-1.0) == "-1"
    assert canonicalize_for_evidence(1000.0) == "1000"


def test_fractional_floats() -> None:
    assert canonicalize_for_evidence(1.5) == "1.5"
    assert canonicalize_for_evidence(-0.5) == "-0.5"
    # Standard precision-loss case; both runtimes produce the same bytes.
    assert canonicalize_for_evidence(0.1 + 0.2) == "0.30000000000000004"


def test_non_finite_floats_render_as_null() -> None:
    assert canonicalize_for_evidence(float("nan")) == "null"
    assert canonicalize_for_evidence(float("inf")) == "null"
    assert canonicalize_for_evidence(float("-inf")) == "null"
    assert canonicalize_for_evidence(math.nan) == "null"


def test_strings_are_json_quoted() -> None:
    assert canonicalize_for_evidence("hello") == '"hello"'
    assert canonicalize_for_evidence("") == '""'
    # Must escape internal double-quote and backslash exactly like JSON.stringify.
    assert canonicalize_for_evidence('a"b') == '"a\\"b"'
    assert canonicalize_for_evidence("a\\b") == '"a\\\\b"'


def test_strings_preserve_unicode_via_ensure_ascii_false() -> None:
    # TS JSON.stringify does NOT \u-escape non-ASCII by default; we must match.
    assert canonicalize_for_evidence("café") == '"café"'
    assert canonicalize_for_evidence("中文") == '"中文"'


def test_empty_collections() -> None:
    assert canonicalize_for_evidence([]) == "[]"
    assert canonicalize_for_evidence({}) == "{}"
    assert canonicalize_for_evidence(()) == "[]"


def test_arrays_preserve_order() -> None:
    assert canonicalize_for_evidence([1, 2, 3]) == "[1,2,3]"
    assert canonicalize_for_evidence([3, 1, 2]) == "[3,1,2]"
    assert canonicalize_for_evidence([1, "a", True, None]) == '[1,"a",true,null]'


def test_object_keys_are_sorted_lexicographically() -> None:
    # Insertion order MUST NOT affect output; sorted keys win.
    assert canonicalize_for_evidence({"b": 1, "a": 2}) == '{"a":2,"b":1}'
    assert canonicalize_for_evidence({"z": 1, "a": 2, "m": 3}) == '{"a":2,"m":3,"z":1}'


def test_nested_objects() -> None:
    # Whole-number float elision applies recursively.
    assert (
        canonicalize_for_evidence({"x": [1, 2.0, 2.5], "y": {"b": True, "a": None}})
        == '{"x":[1,2,2.5],"y":{"a":null,"b":true}}'
    )


def test_dicts_with_same_data_produce_same_bytes_regardless_of_construction_order() -> (
    None
):
    a = canonicalize_for_evidence({"first": 1, "second": 2, "third": 3})
    b = canonicalize_for_evidence({"third": 3, "first": 1, "second": 2})
    assert a == b


def test_unsupported_type_renders_as_null() -> None:
    # Mirrors the TS fallthrough at the bottom of canonicalizeForEvidence.
    class Opaque:
        pass

    assert canonicalize_for_evidence(Opaque()) == "null"
