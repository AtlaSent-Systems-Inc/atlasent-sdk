"""Regenerate the canonicalization contract vectors.

Produces ``contract/vectors/v2/canonicalize/*.json`` — golden
input → expected-bytes pairs both v2-preview SDKs (TS + Python)
already exercise via internal vector arrays. Pulling them onto disk
lets non-SDK adopters (a future Go SDK, the API server, regulator-
side custom verifiers) consume the same set without re-implementing
shared-vector logic.

Reference: ``contract/schemas/v2/README.md`` §"Canonical JSON" —
sorted keys at every depth, no whitespace, ``None`` / ``NaN`` /
``±inf`` render as ``null``, strings escaped via
``json.dumps(ensure_ascii=False)``.

Output schema (one file per vector group)::

    {
      "description": "...",
      "vectors": [
        { "name": "...", "input": <any>, "expected": "<canonical bytes>" },
        ...
      ]
    }

Run:  ``python contract/tools/gen_canonicalize_vectors.py``
"""

from __future__ import annotations

import json
import math
from pathlib import Path

# Re-uses the canonicalizer from the v2 proof-bundle generator so
# the two stay in lockstep.
from gen_proof_bundles import canonical_json  # type: ignore[import-not-found]


def _vector(name: str, value: object) -> dict:
    """Build one fixture entry.

    ``input`` is the value to canonicalize, JSON-encoded inside the
    fixture file. JSON itself can't round-trip ``NaN`` / ``±inf``,
    so non-finite-number vectors don't live on disk — both SDKs
    test them inline. Callers reproduce by parsing ``input`` with
    their JSON parser and feeding it to their canonicalizer.
    """
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        raise ValueError(
            f"non-finite number value not representable in JSON fixture: {value}"
        )
    return {
        "name": name,
        "input": value,
        "expected": canonical_json(value),
    }


def _write_group(out: Path, group: str, vectors: list[dict], description: str) -> None:
    payload = {"description": description, "vectors": vectors}
    target = out / f"{group}.json"
    target.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    out = Path(__file__).resolve().parents[1] / "vectors" / "v2" / "canonicalize"
    out.mkdir(parents=True, exist_ok=True)

    # ── Primitives ──────────────────────────────────────────────────
    # Non-finite numbers (NaN, ±inf) intentionally absent — JSON can't
    # round-trip them. Both SDKs cover them inline in their unit tests.
    primitives = [
        _vector("null", None),
        _vector("true", True),
        _vector("false", False),
        _vector("zero", 0),
        _vector("positive_int", 42),
        _vector("negative_int", -7),
        _vector("float", -1.5),
        _vector("empty_string", ""),
        _vector("ascii_string", "hello"),
        _vector("string_with_quote", 'he said "hi"'),
        _vector("string_with_escapes", "tab\there\nnewline"),
        _vector("unicode_string", "漢字 é π"),
    ]
    _write_group(
        out,
        "primitives",
        primitives,
        "Primitive value canonicalization. Locks string-escape and "
        "non-finite-number rendering rules.",
    )

    # ── Empty containers ────────────────────────────────────────────
    empties = [
        _vector("empty_object", {}),
        _vector("empty_array", []),
        _vector("nested_empties", {"obj": {}, "arr": []}),
    ]
    _write_group(
        out, "empties", empties, "Empty containers and nested empties."
    )

    # ── Object key ordering ─────────────────────────────────────────
    ordering = [
        _vector("two_keys_unsorted_input", {"b": 1, "a": 2}),
        _vector("nested_unsorted", {"b": {"d": 4, "c": 3}, "a": 1}),
        _vector(
            "deeply_nested_unsorted",
            {
                "z": {"y": {"x": 3, "w": 2}, "v": 1},
                "a": [{"c": 1, "b": 2}, {"e": 5, "d": 4}],
            },
        ),
        _vector("unicode_keys", {"漢": 1, "z": 2, "a": 3}),
    ]
    _write_group(
        out,
        "key_ordering",
        ordering,
        "Object keys MUST sort lexicographically at every depth. "
        "Unicode keys sort by their string ordering.",
    )

    # ── Array order preservation ────────────────────────────────────
    arrays = [
        _vector("simple_array", [3, 1, 2]),
        _vector("array_of_objects", [{"b": 1}, {"a": 2}, {"c": 3}]),
        _vector("nested_arrays", [[1, 2], [3, 4]]),
        _vector(
            "mixed",
            [1, "two", {"three": 3}, [4, 5], None],
        ),
    ]
    _write_group(
        out,
        "arrays",
        arrays,
        "Arrays preserve input order; their contents canonicalize.",
    )

    # ── Realistic payloads (Pillar 9 evaluate-style shapes) ────────
    realistic = [
        _vector(
            "evaluate_context",
            {
                "user": "dr_smith",
                "environment": "production",
                "patient_id": "PT-2024-001",
            },
        ),
        _vector(
            "deploy_payload",
            {
                "commit": "abc123",
                "approver": "sre@example.com",
                "env": "prod",
                "meta": {"ts": "2026-04-25T12:00:00Z", "ci": True},
            },
        ),
        _vector(
            "complex_payload_with_nulls",
            {
                "fields": {"a": None, "b": "x", "c": [1, None, 3]},
                "tags": [],
                "meta": {"empty": {}},
            },
        ),
    ]
    _write_group(
        out,
        "realistic_payloads",
        realistic,
        "Pillar-9-style payload shapes. Useful as smoke tests for "
        "downstream canonicalizers.",
    )

    print(f"wrote canonicalization vectors under {out}")


if __name__ == "__main__":
    main()
