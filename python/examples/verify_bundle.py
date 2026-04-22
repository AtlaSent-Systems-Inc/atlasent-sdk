"""Offline-verify a signed audit-export bundle.

Run with::

    python examples/verify_bundle.py atlasent-audit-export.json \\
        path/to/trusted-public-key.pem

The trust-anchor PEM is optional; omit it for a self-verify only
(the bundle verifies its own signature against the embedded key,
but can't tell you the signer is who you think it is).

Requires the ``verify`` extra::

    pip install 'atlasent[verify]'
"""

from __future__ import annotations

import sys

from atlasent import verify_bundle


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "usage: python verify_bundle.py <export.json> [trust-anchor.pem]",
            file=sys.stderr,
        )
        return 2

    export_path = sys.argv[1]
    trusted_pem: str | None = None
    if len(sys.argv) >= 3:
        with open(sys.argv[2], encoding="utf-8") as f:
            trusted_pem = f.read()

    result = verify_bundle(export_path, trusted_public_key_pem=trusted_pem)

    print(f"chain_ok:      {result.chain_ok}")
    print(f"signature_ok:  {result.signature_ok}")
    if result.trusted_key_ok is not None:
        print(f"trusted_key:   {result.trusted_key_ok}")
    for err in result.errors:
        print(f"  - {err}", file=sys.stderr)

    print("VERIFIED" if result.ok else "FAILED")
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
