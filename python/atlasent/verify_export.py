"""Offline verifier for a signed AtlaSent audit-export bundle.

Fed an envelope returned from :meth:`AtlaSentClient.export_audit`
(or loaded from disk), this verifies:

1. For each row in the execution + admin chains:
   ``sha256(canonical_payload) == entry_hash``.
2. Each row's ``canonical_payload`` ends with the previous row's
   ``entry_hash`` (or ``'GENESIS'`` for row 0).
3. The Ed25519 signature over
   ``canonicalize(envelope - signature)`` verifies against the
   embedded ``public_key_pem``.
4. When ``trusted_public_key_pem`` is supplied, that the embedded key
   matches it byte-for-byte — so the verifier trusts a key **you**
   provisioned, not one shipped inside the envelope.

Requires the optional ``cryptography`` dependency. Install with::

    pip install 'atlasent[verify]'
"""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .canonical import canonicalize, sha256_hex


@dataclass
class ExportVerifyResult:
    """Outcome of :func:`verify_bundle` / :func:`verify_audit_export`.

    ``ok`` is ``True`` iff the chain and signature both verify, and
    (when a trust anchor was supplied) the embedded key matches it.
    """

    chain_ok: bool
    signature_ok: bool
    trusted_key_ok: bool | None = None
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return (
            self.chain_ok
            and self.signature_ok
            and (self.trusted_key_ok is None or self.trusted_key_ok)
        )


def verify_bundle(
    envelope: Mapping[str, Any] | str | Path,
    *,
    trusted_public_key_pem: str | None = None,
) -> ExportVerifyResult:
    """Verify a signed audit-export envelope without hitting the API.

    Args:
        envelope: Either the parsed envelope dict (e.g.
            ``AuditExportBundle.model_dump()`` or ``bundle.raw``), or
            a path to a JSON file on disk.
        trusted_public_key_pem: The Ed25519 public key you trust,
            provisioned out of band. When supplied, the verifier
            asserts the envelope's embedded key matches byte-for-byte.

    Returns:
        :class:`ExportVerifyResult`. Check ``.ok`` for the final
        answer; ``.errors`` holds human-readable diagnostics.
    """
    if isinstance(envelope, (str, Path)):
        with open(envelope, encoding="utf-8") as f:
            envelope = json.load(f)
    if not isinstance(envelope, Mapping):
        raise TypeError(
            "verify_bundle: envelope must be a mapping, str, or Path "
            f"(got {type(envelope).__name__})"
        )
    return _verify(envelope, trusted_public_key_pem)


# Back-compat alias matching the atlasent-api reference SDK.
verify_audit_export = verify_bundle


def _verify(
    envelope: Mapping[str, Any],
    trusted_public_key_pem: str | None,
) -> ExportVerifyResult:
    result = ExportVerifyResult(chain_ok=False, signature_ok=False)

    chain_ok = _verify_chain(
        envelope.get("evaluations") or [],
        envelope.get("execution_head"),
        "execution",
        result.errors,
    ) and _verify_chain(
        envelope.get("admin_log") or [],
        envelope.get("admin_head"),
        "admin",
        result.errors,
    )
    result.chain_ok = chain_ok

    signature = envelope.get("signature")
    pem = envelope.get("public_key_pem")
    if not signature or not pem:
        result.errors.append("missing signature or public_key_pem")
        return result

    try:
        public_key = _load_ed25519_public_key(str(pem))
    except Exception as err:  # noqa: BLE001 — propagate as a verify failure
        result.errors.append(f"could not parse embedded public key: {err}")
        return result

    env_minus_sig = {k: v for k, v in envelope.items() if k != "signature"}
    canonical_bytes = canonicalize(env_minus_sig).encode("utf-8")
    try:
        sig_bytes = base64.b64decode(str(signature), validate=False)
    except Exception as err:  # noqa: BLE001
        result.errors.append(f"signature is not valid base64: {err}")
        return result

    try:
        public_key.verify(sig_bytes, canonical_bytes)
        result.signature_ok = True
    except Exception as err:  # noqa: BLE001 — InvalidSignature or anything else
        result.errors.append(
            f"signature does not verify against embedded public key: {err}"
        )

    if trusted_public_key_pem is not None:
        trusted_ok = _pem_normalize(trusted_public_key_pem) == _pem_normalize(str(pem))
        result.trusted_key_ok = trusted_ok
        if not trusted_ok:
            result.errors.append(
                "embedded public key does not match the trusted anchor"
            )

    return result


def _verify_chain(
    rows: list[Any],
    claimed_head: Any,
    label: str,
    errors: list[str],
) -> bool:
    prev: str | None = None
    for i, row in enumerate(rows):
        if not isinstance(row, Mapping):
            errors.append(f"{label} row {i}: expected an object")
            return False
        payload = row.get("canonical_payload")
        stored = row.get("entry_hash")
        if not isinstance(payload, str) or not isinstance(stored, str):
            errors.append(
                f"{label} row {i}: missing canonical_payload or entry_hash"
            )
            return False

        if sha256_hex(payload) != stored:
            errors.append(
                f"{label} row {i} ({row.get('id')}): "
                f"sha256(canonical_payload) != entry_hash"
            )
            return False

        segments = payload.split("|")
        payload_prev = segments[-1] if segments else ""
        expected_prev = prev if prev is not None else "GENESIS"
        if payload_prev != expected_prev:
            errors.append(
                f"{label} row {i}: payload prev '{payload_prev}' "
                f"!= '{expected_prev}'"
            )
            return False
        prev = stored

    if (
        claimed_head
        and rows
        and isinstance(claimed_head, Mapping)
        and claimed_head.get("entry_hash") != prev
    ):
        errors.append(
            f"{label}: claimed head {claimed_head.get('entry_hash')} "
            f"does not match tail {prev}"
        )
        return False
    return True


def _load_ed25519_public_key(pem: str) -> Any:
    try:
        from cryptography.hazmat.primitives.serialization import load_pem_public_key
    except ImportError as err:  # pragma: no cover — guarded by extras
        raise RuntimeError(
            "verify_bundle requires the 'cryptography' package. "
            "Install with: pip install 'atlasent[verify]'"
        ) from err
    return load_pem_public_key(pem.encode("utf-8"))


def _pem_normalize(pem: str) -> str:
    """Strip PEM armour + whitespace for byte-equality comparison."""
    return (
        pem.replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "")
        .replace("\r", "")
        .replace("\n", "")
        .replace(" ", "")
        .strip()
    )
