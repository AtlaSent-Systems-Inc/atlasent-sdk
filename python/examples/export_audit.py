"""Export a signed, offline-verifiable audit bundle to disk.

Requires an API key with the ``audit`` scope.

Run with:
    ATLASENT_API_KEY=ask_live_... python examples/export_audit.py
"""

from __future__ import annotations

import json
import os
import sys

from atlasent import AtlaSentClient

api_key = os.environ.get("ATLASENT_API_KEY")
if not api_key:
    print("ATLASENT_API_KEY env var is required", file=sys.stderr)
    sys.exit(1)

with AtlaSentClient(api_key=api_key) as client:
    bundle = client.export_audit(
        since="2026-01-01T00:00:00Z",
        limit=5000,
    )

out_path = "atlasent-audit-export.json"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(bundle.model_dump(), f, indent=2)

print(
    f"wrote {len(bundle.evaluations)} evaluations "
    f"+ {0 if bundle.admin_log is None else len(bundle.admin_log)} admin rows "
    f"to {out_path}"
)
print(f"signature: {bundle.signature[:32]}…")
