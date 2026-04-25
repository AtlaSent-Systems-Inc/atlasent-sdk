# `atlasent-verify`

Offline verifier for AtlaSent's signed audit-export bundles.

The carved-out verifier package — auditors install only this, not the
full `atlasent` (which carries HTTP clients, retries, observability,
and contract-drift tooling).

## Install

```bash
pip install atlasent-verify
```

This currently pulls in `atlasent` as a dependency while the
source-of-truth relocation lands; a future release will let you
install `atlasent-verify` alone.

## Use

```python
import json
from atlasent_verify import verify_bundle

with open("export.json", "rb") as f:
    bundle = json.load(f)

with open("atlasent-verifier-key.pem") as f:
    public_key_pem = f.read()

result = verify_bundle(bundle, public_keys_pem=[public_key_pem])
if not result.valid:
    raise RuntimeError(f"Bundle invalid: {result.reason}")
```

The verifier is byte-identical with the reference implementation in
`atlasent-api/supabase/functions/v1-audit/verify.ts`.

## License

Apache-2.0.
