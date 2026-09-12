#!/usr/bin/env python3
"""Re-vendor atlasent/vendored_trust_root.py from the canonical public trust
root published by atlasent-keys.

Source of truth (in priority order):
  1. atlasent-keys/.well-known/atlasent-trust-root.json    (issued_at / valid_until)
     atlasent-keys/.well-known/atlasent-verifier-keys.json (keys)
     atlasent-keys/.well-known/atlasent-revocations.json   (revoked_keys /
       revoked_identities)
  2. https://keys.atlasent.io/.well-known/<file> -- same three files, live.

This is the Python counterpart to typescript/scripts/vendor-trust-root.mjs
-- see that script's header and trust_root.py's module docstring for the
incident this closes. Run it whenever atlasent-keys' trust root changes (a
key rotation, a revocation) so the SDK's embedded baseline snapshot stays
current; TrustRootManager's background refresh still keeps a long-running
process fresh between vendoring passes.

Usage:
  python scripts/vendor_trust_root.py [path/to/atlasent-keys/.well-known]

Default path assumes atlasent-keys is a sibling checkout of atlasent-sdk/.
Falls back to a live fetch from keys.atlasent.io if the local checkout
isn't found and no path was given.
"""

from __future__ import annotations

import json
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_PATH = HERE.parent / "atlasent" / "vendored_trust_root.py"
LIVE_BASE_URL = "https://keys.atlasent.io/.well-known"


def _load_three(local_dir: Path | None) -> tuple[dict, dict, dict]:
    if local_dir is not None:
        trust_root = json.loads((local_dir / "atlasent-trust-root.json").read_text())
        verifier_keys = json.loads(
            (local_dir / "atlasent-verifier-keys.json").read_text()
        )
        revocations = json.loads((local_dir / "atlasent-revocations.json").read_text())
        return trust_root, verifier_keys, revocations

    def fetch(name: str) -> dict:
        with urllib.request.urlopen(
            f"{LIVE_BASE_URL}/{name}", timeout=10
        ) as resp:  # noqa: S310
            return json.load(resp)

    return (
        fetch("atlasent-trust-root.json"),
        fetch("atlasent-verifier-keys.json"),
        fetch("atlasent-revocations.json"),
    )


def main() -> int:
    arg_path = sys.argv[1] if len(sys.argv) > 1 else None
    default_local_dir = HERE.parent.parent.parent / "atlasent-keys" / ".well-known"
    local_dir: Path | None
    if arg_path:
        local_dir = Path(arg_path).resolve()
    elif default_local_dir.is_dir():
        local_dir = default_local_dir
    else:
        local_dir = None

    trust_root, verifier_keys, revocations = _load_three(local_dir)

    snapshot = {
        "valid_until": trust_root["valid_until"],
        "issued_at": trust_root["issued_at"],
        "keys": verifier_keys.get("keys", []),
        "revoked_keys": revocations.get("revoked_keys", []),
        "revoked_identities": revocations.get("revoked_identities", []),
    }

    source = str(local_dir) if local_dir is not None else LIVE_BASE_URL

    module = f'''"""GENERATED-DERIVED -- do not edit directly.

Source: atlasent-keys' .well-known/{{atlasent-trust-root,atlasent-verifier-keys,
  atlasent-revocations}}.json -- the canonical public trust root published at
  https://keys.atlasent.io/.well-known/.
Re-vendor: python scripts/vendor_trust_root.py [path/to/atlasent-keys/.well-known]
Do NOT hand-edit -- update atlasent-keys upstream and re-vendor.

This is the SDK's embedded baseline trust-root snapshot (see trust_root.py).
It is a plain dict literal on purpose: no file I/O, no path resolution at
import time, so it can never silently fail to load the way the previous
Path(__file__).parent.parent.parent / "vendor" / "trust-root" design did
(see trust_root.py's module docstring for the incident this closes).
TrustRootManager's background refresh keeps a long-running process current
between vendoring passes; this baseline is what every process has from the
very first call, with no network round-trip and no reliance on files
shipping alongside the installed package.
"""

from __future__ import annotations

from typing import Any

VENDORED_TRUST_ROOT_SNAPSHOT_DATA: dict[str, Any] = {snapshot!r}
'''

    OUT_PATH.write_text(module)
    try:
        subprocess.run(
            ["black", "--quiet", str(OUT_PATH)], check=True
        )  # noqa: S603, S607
    except (subprocess.CalledProcessError, FileNotFoundError):
        print(
            f"[vendor-trust-root] warning: could not auto-format {OUT_PATH} with black "
            "(unreadable but still valid Python)",
            file=sys.stderr,
        )
    n_keys = len(snapshot["keys"])
    n_revoked = len(snapshot["revoked_keys"])
    print(
        f"vendored {OUT_PATH} from {source} -- "
        f"{n_keys} key(s), {n_revoked} revocation(s), "
        f"valid_until {snapshot['valid_until']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
