"""Canonicalization test suite.

Covers the deterministic-JSON rules documented in ``canonicalize.py``
and locked-in by the v2 schemas: sorted keys at every depth, no
whitespace, None / NaN / non-finite numbers render as ``"null"``,
strings escaped via ``json.dumps(ensure_ascii=False)``.

The ``v1 parity`` block below imports the v1 implementation of
``canonical_json`` and asserts byte-for-byte agreement across a set
of tricky vectors. If this ever fails, one of the two has drifted
and must be fixed before any further Pillar 9 work lands.
"""

from __future__ import annotations

import math

import pytest

from atlasent_v2_preview.canonicalize import canonicalize_payload

# v1 parity — imported lazily inside the parity test so a missing
# ``atlasent`` install only skips that one test rather than the whole
# suite.


class TestRules:
    def test_primitives(self):
        assert canonicalize_payload(None) == "null"
        assert canonicalize_payload(True) == "true"
        assert canonicalize_payload(False) == "false"
        assert canonicalize_payload("hi") == '"hi"'
        assert canonicalize_payload(42) == "42"
        assert canonicalize_payload(0) == "0"
        assert canonicalize_payload(-1.5) == "-1.5"

    def test_non_finite_numbers_render_as_null(self):
        assert canonicalize_payload(math.nan) == "null"
        assert canonicalize_payload(math.inf) == "null"
        assert canonicalize_payload(-math.inf) == "null"

    def test_object_keys_sorted_at_every_depth(self):
        obj = {
            "b": 1,
            "a": 2,
            "nested": {
                "zebra": True,
                "alpha": {"delta": 4, "beta": 3},
            },
        }
        assert (
            canonicalize_payload(obj)
            == '{"a":2,"b":1,"nested":{"alpha":{"beta":3,"delta":4},"zebra":true}}'
        )

    def test_arrays_preserve_order_but_canonicalize_elements(self):
        arr = [{"b": 1, "a": 2}, None, [3, 2, 1]]
        assert canonicalize_payload(arr) == '[{"a":2,"b":1},null,[3,2,1]]'

    def test_no_whitespace(self):
        out = canonicalize_payload({"a": 1, "b": [2, 3], "c": {"d": 4}})
        assert " " not in out
        assert "\t" not in out
        assert "\n" not in out

    def test_string_escapes_match_json_dumps(self):
        assert canonicalize_payload('he said "hi"') == '"he said \\"hi\\""'
        assert canonicalize_payload("tab\there") == '"tab\\there"'
        assert canonicalize_payload("line\nbreak") == '"line\\nbreak"'

    def test_empty_object_and_array(self):
        assert canonicalize_payload({}) == "{}"
        assert canonicalize_payload([]) == "[]"

    def test_unicode_strings_survive(self):
        # ensure_ascii=False — unicode round-trips.
        assert canonicalize_payload({"é": "π", "漢": ["字", None]}) == (
            '{"é":"π","漢":["字",null]}'
        )

    def test_tuples_canonicalize_like_lists(self):
        assert canonicalize_payload((1, 2, 3)) == "[1,2,3]"
        assert canonicalize_payload(({"b": 1, "a": 2},)) == '[{"a":2,"b":1}]'

    def test_rejects_non_string_keys(self):
        with pytest.raises(TypeError, match="string keys"):
            canonicalize_payload({1: "one"})

    def test_rejects_unknown_types(self):
        class Foo:
            pass

        with pytest.raises(TypeError, match="cannot canonicalize"):
            canonicalize_payload(Foo())


class TestV1Parity:
    """Byte-for-byte agreement with v1's ``canonical_json``.

    If these break, v2-preview and v1 have drifted on the
    canonicalization algorithm — a silent proof-signature failure in
    the making. Fix before shipping.
    """

    VECTORS = [
        None,
        True,
        42,
        -0.001,
        "hello",
        'with "quote" and \n newline',
        [],
        {},
        {"z": 1, "a": 2},
        {"a": {"c": 3, "b": 2}, "nested": [True, False, None]},
        {"mixed": [1, "two", {"three": 3}, [4, 5]]},
        {"empty_arr": [], "empty_obj": {}},
        math.nan,
        math.inf,
        {"unicode": "漢字 é π"},
    ]

    @pytest.mark.parametrize("vector", VECTORS, ids=range(len(VECTORS)))
    def test_matches_v1(self, vector):
        try:
            from atlasent.audit_bundle import canonical_json as v1_canonical
        except ImportError:
            pytest.skip("atlasent v1 not installed — run `pip install -e '.[dev]'`")

        assert canonicalize_payload(vector) == v1_canonical(vector)
