"""Tests for contract/adopt/validate_response.py.

Exercised the same way an adopter repo would call it — as a CLI
subprocess — plus a couple of direct-import checks for the internal
helpers. Keeps the adopter-side integration honest without pulling
in any extra deps.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve()
CONTRACT_DIR = HERE.parents[1]
SCRIPT = CONTRACT_DIR / "adopt" / "validate_response.py"
VECTORS = CONTRACT_DIR / "vectors"


def _run(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        input=stdin,
        capture_output=True,
        text=True,
        check=False,
    )


def _valid_evaluate_response() -> dict:
    data = json.loads((VECTORS / "evaluate.json").read_text())
    return data["vectors"][0]["wire_response"]


def test_cli_script_is_executable():
    assert SCRIPT.exists()


def test_valid_body_exits_zero(tmp_path):
    body = _valid_evaluate_response()
    fixture = tmp_path / "ok.json"
    fixture.write_text(json.dumps(body))
    result = _run("evaluate-response", str(fixture))
    assert result.returncode == 0, result.stderr
    assert "[OK]" in result.stdout


def test_invalid_body_exits_one(tmp_path):
    fixture = tmp_path / "bad.json"
    fixture.write_text(json.dumps({"foo": "bar"}))
    result = _run("evaluate-response", str(fixture))
    assert result.returncode == 1
    assert "[FAIL]" in result.stderr


def test_unknown_endpoint_exits_two(tmp_path):
    fixture = tmp_path / "x.json"
    fixture.write_text("{}")
    result = _run("nope-endpoint", str(fixture))
    assert result.returncode == 2
    assert "Unknown endpoint" in result.stderr


def test_missing_file_exits_two():
    result = _run("evaluate-response", "/no/such/file.json")
    assert result.returncode == 2
    assert "Input file not found" in result.stderr


def test_stdin_input_works():
    body = json.dumps(_valid_evaluate_response())
    result = _run("evaluate-response", "-", stdin=body)
    assert result.returncode == 0, result.stderr


def test_environment_override_for_schemas_dir(tmp_path):
    # Copy the schemas to a new location and point the env var at it.
    schemas_src = CONTRACT_DIR / "schemas"
    schemas_dst = tmp_path / "custom-schemas"
    schemas_dst.mkdir()
    for src in schemas_src.glob("*.schema.json"):
        (schemas_dst / src.name).write_bytes(src.read_bytes())
    body = tmp_path / "body.json"
    body.write_text(json.dumps(_valid_evaluate_response()))

    env = {**os.environ, "ATLASENT_CONTRACT_SCHEMAS": str(schemas_dst)}
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "evaluate-response", str(body)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_verify_permit_vector_passes(tmp_path):
    data = json.loads((VECTORS / "verify.json").read_text())
    body = data["vectors"][0]["wire_response"]
    fixture = tmp_path / "verify.json"
    fixture.write_text(json.dumps(body))
    result = _run("verify-permit-response", str(fixture))
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "endpoint",
    [
        "evaluate-request",
        "evaluate-response",
        "verify-permit-request",
        "verify-permit-response",
        "error-response",
        "policy",
    ],
)
def test_all_documented_endpoints_resolve(endpoint, tmp_path):
    # A trivially-empty object isn't valid for any of these (most
    # have required fields), so exit 1 is expected — we just want to
    # confirm the script recognizes the endpoint, not reject it with
    # exit 2.
    fixture = tmp_path / "empty.json"
    fixture.write_text("{}")
    result = _run(endpoint, str(fixture))
    assert result.returncode in (0, 1), (
        f"endpoint {endpoint} unexpectedly unknown: {result.stderr}"
    )
