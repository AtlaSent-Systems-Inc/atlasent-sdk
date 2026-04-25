"""atlasent-verify — offline verifier for AtlaSent signed audit-export bundles.

This package re-exports the verifier from ``atlasent`` so customers and
auditors can verify a signed export without pulling in the HTTP client,
retry, observability, or contract-drift layers of the full SDK.

Quick start::

    from atlasent_verify import verify_bundle

    with open("export.json", "rb") as f:
        bundle = json.load(f)

    public_key_pem = open("atlasent-verifier-key.pem").read()

    result = verify_bundle(bundle, public_keys_pem=[public_key_pem])
    if not result.valid:
        raise RuntimeError(f"Bundle invalid: {result.reason}")

The verifier is **byte-identical** with the reference implementation
in ``atlasent-api/supabase/functions/v1-audit/verify.ts``. A bundle
that verifies in the backend verifies here, and vice versa.

Status: scaffold. The Python verifier currently lives in ``atlasent``
(``atlasent.audit_bundle``) and is re-exported from here with no
behavioural change. A subsequent release will relocate the source
so this package contains the canonical verifier and ``atlasent``
re-exports from here.
"""

from atlasent.audit_bundle import (
    BundleVerificationResult,
    VerifyKey,
    verify_audit_bundle,
    verify_bundle,
)

__all__ = [
    "verify_bundle",
    "verify_audit_bundle",
    "BundleVerificationResult",
    "VerifyKey",
]
