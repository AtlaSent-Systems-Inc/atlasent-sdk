"""Lazy top-level import surface (PEP 562) — regression guards.

These lock in the behaviour added when ``atlasent/__init__.py`` moved from
eager to lazy imports:

* ``import atlasent`` must NOT pull in the HTTP client stack (``httpx``) or
  ``pydantic``. This keeps the network-free offline verifier CLI
  (``atlasent-verify-bundle``) importable with just ``cryptography`` + the
  standard library — the artifact an auditor runs.
* The full public surface (``__all__``) still resolves on attribute access.
* The submodule/symbol name collisions (``authorize`` / ``with_permit`` /
  ``require_permit``) still resolve to the exported *callable*, per the
  documented contract, even after the submodule has been imported elsewhere.
"""

from __future__ import annotations

import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

import atlasent

_VECTORS = (
    Path(__file__).resolve().parents[2] / "contract" / "vectors" / "evidence-bundles"
)


def _subprocess_python(code: str) -> subprocess.CompletedProcess[str]:
    """Run ``code`` in a fresh interpreter that can import this ``atlasent``."""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(sys.path)
    return subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        env=env,
    )


def test_import_atlasent_does_not_load_httpx_or_pydantic() -> None:
    """The headline guarantee: a bare ``import atlasent`` stays HTTP-free.

    Checked in a *fresh* interpreter so an already-imported httpx (from
    another test) can't mask a regression.
    """
    proc = _subprocess_python(
        "import sys, atlasent;"
        "loaded = [m for m in ('httpx', 'pydantic') if m in sys.modules];"
        "print(','.join(loaded));"
        "sys.exit(1 if loaded else 0)"
    )
    assert (
        proc.returncode == 0
    ), f"import atlasent eagerly loaded: {proc.stdout.strip()!r}\n{proc.stderr}"


def test_offline_verifier_imports_without_httpx() -> None:
    """The CLI's verifier path loads with cryptography + stdlib only."""
    proc = _subprocess_python(
        "import sys;"
        "from atlasent.evidence_bundle_verifier import verify_evidence_bundle;"
        "sys.exit(1 if 'httpx' in sys.modules else 0)"
    )
    assert (
        proc.returncode == 0
    ), f"importing the verifier pulled in httpx:\n{proc.stdout}\n{proc.stderr}"


def test_every_public_name_resolves() -> None:
    unresolved = []
    for name in atlasent.__all__:
        try:
            getattr(atlasent, name)
        except AttributeError as exc:  # pragma: no cover - failure path
            unresolved.append((name, str(exc)))
    assert not unresolved, f"unresolved __all__ names: {unresolved}"


def test_dunder_all_has_no_duplicates_except_known() -> None:
    # ``BundleVerificationError`` is intentionally listed twice in __all__
    # (kept from the original surface); everything else should be unique.
    counts: dict[str, int] = {}
    for name in atlasent.__all__:
        counts[name] = counts.get(name, 0) + 1
    dupes = {n: c for n, c in counts.items() if c > 1}
    assert dupes == {"BundleVerificationError": 2}, dupes


def test_dir_lists_public_surface() -> None:
    names = dir(atlasent)
    assert "protect" in names
    assert "verify_evidence_bundle" in names
    # __dir__ returns a sorted, de-duplicated view.
    assert names == sorted(names)


def test_unknown_attribute_raises_attribute_error() -> None:
    with pytest.raises(AttributeError):
        atlasent.this_name_does_not_exist  # noqa: B018


def test_submodule_access_returns_module() -> None:
    # A submodule with no same-named export resolves to the module object.
    assert isinstance(atlasent.taxonomy, types.ModuleType)
    assert atlasent.taxonomy.__name__ == "atlasent.taxonomy"


def test_v2_alias_exports_resolve() -> None:
    # Re-exports whose public name differs from the source attribute.
    for alias in ("V2_BATCH_PATH", "V2_STREAM_PATH", "V2_GRAPHQL_PATH"):
        assert isinstance(getattr(atlasent, alias), str)
    assert isinstance(atlasent.V2_MAX_BATCH_ITEMS, int)


@pytest.mark.parametrize("name", ["authorize", "with_permit", "require_permit"])
def test_collision_name_resolves_to_callable_after_submodule_import(
    name: str,
) -> None:
    """``authorize`` etc. must stay the *function*, not the shadowing module.

    Importing the submodule first reproduces the cross-module ordering that
    previously flipped ``atlasent.authorize`` to the module object.
    """
    import importlib

    importlib.import_module(f"atlasent.{name}")  # bind submodule onto package
    value = getattr(atlasent, name)
    assert callable(value)
    assert not isinstance(value, types.ModuleType)
    # The real submodule is still reachable via sys.modules.
    assert isinstance(sys.modules[f"atlasent.{name}"], types.ModuleType)


@pytest.mark.skipif(not _VECTORS.exists(), reason="evidence-bundle vectors absent")
def test_cli_verify_bundle_end_to_end() -> None:
    """The ``atlasent-verify-bundle`` CLI: valid → exit 0, tampered → exit 1."""
    pytest.importorskip("cryptography")
    from atlasent import _cli_verify

    key_set = str(_VECTORS / "key-set.json")

    def run(bundle: str) -> int:
        argv = ["atlasent-verify-bundle", str(_VECTORS / bundle), key_set]
        old = sys.argv
        sys.argv = argv
        try:
            _cli_verify.main()
            return 0
        except SystemExit as exc:
            return int(exc.code or 0)
        finally:
            sys.argv = old

    assert run("valid-3-records.json") == 0
    for tampered in (
        "entry-tampered.json",
        "tampered-signature.json",
        "broken-chain.json",
        "summary-mismatch.json",
        "unknown-key.json",
    ):
        assert run(tampered) == 1, f"{tampered} should fail closed"
