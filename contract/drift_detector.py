"""AtlaSent SDK Contract Drift Detector.

Runs evaluate and verify_permit test vectors against a live (or mocked)
AtlaSent backend and reports any response shape drift.

Usage:
    python contract/drift_detector.py --base-url https://... --api-key ask_live_...
    python contract/drift_detector.py --mock   # uses mock responses from vectors
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

try:
    import httpx
except ImportError:
    print("Install httpx: pip install httpx", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).parent
EVALUATE_VECTORS = json.loads((ROOT / "vectors" / "evaluate.json").read_text())
VERIFY_VECTORS = json.loads((ROOT / "vectors" / "verify.json").read_text())


def check_shape(response: dict[str, Any], expected: dict[str, Any], vector_id: str) -> list[str]:
    """Return list of drift messages; empty means OK."""
    drifts = []
    for key, val in expected.items():
        if key not in response:
            drifts.append(f"{vector_id}: missing key '{key}'")
        elif response[key] != val:
            drifts.append(f"{vector_id}: '{key}' expected {val!r}, got {response[key]!r}")
    return drifts


def run_mock(vectors: list[dict], endpoint: str) -> list[str]:
    """Validate mock responses match the 'expect' shapes."""
    drifts = []
    for v in vectors:
        if "mock_response" not in v:
            continue
        drifts.extend(check_shape(v["mock_response"], v.get("expect", {}), v["id"]))
    return drifts


def run_live(
    vectors: list[dict],
    endpoint: str,
    base_url: str,
    api_key: str,
) -> list[str]:
    """Call the live API and validate response shapes."""
    drifts = []
    with httpx.Client(base_url=base_url, headers={"Authorization": f"Bearer {api_key}"}, timeout=10) as client:
        for v in vectors:
            if v.get("mock_status", 200) != 200:
                continue
            try:
                resp = client.post(endpoint, json=v["request"])
                resp.raise_for_status()
                body = resp.json()
                drifts.extend(check_shape(body, v.get("expect", {}), v["id"]))
            except Exception as exc:
                drifts.append(f"{v['id']}: request failed: {exc}")
    return drifts


def main() -> None:
    parser = argparse.ArgumentParser(description="AtlaSent SDK drift detector")
    parser.add_argument("--base-url", default="https://api.atlasent.io")
    parser.add_argument("--api-key", default="")
    parser.add_argument("--mock", action="store_true", help="Use mock responses only (no network)")
    args = parser.parse_args()

    all_drifts: list[str] = []

    if args.mock:
        all_drifts += run_mock(EVALUATE_VECTORS, "/v1-evaluate")
        all_drifts += run_mock(VERIFY_VECTORS, "/v1-verify-permit")
    else:
        if not args.api_key:
            print("--api-key is required for live mode", file=sys.stderr)
            sys.exit(1)
        all_drifts += run_live(EVALUATE_VECTORS, "/v1-evaluate", args.base_url, args.api_key)
        all_drifts += run_live(VERIFY_VECTORS, "/v1-verify-permit", args.base_url, args.api_key)

    if all_drifts:
        print(f"\n{len(all_drifts)} drift(s) detected:\n")
        for d in all_drifts:
            print(f"  \u2716  {d}")
        sys.exit(1)
    else:
        print("\u2713  No drift detected")


if __name__ == "__main__":
    main()
