"""Offline verification for v2 Pillar 9 Verifiable Proof Objects.

Python sibling of the TypeScript replay harness in
``typescript/packages/v2-preview/src/verifyProof.ts``. Shape, check
names, reason codes, and the 16-field signed-envelope convention
are byte-identical so a proof signed by one language verifies
under the other.

Checks run per proof (names match
``proof-verification-result.schema.json``):

* ``signature``            — Ed25519 signature valid under one of
                             the supplied public keys. Rotation-aware
                             via ``signing_key_id`` hint.
* ``chain_link``           — ``previous_hash`` matches the prior
                             proof's ``chain_hash`` (genesis is
                             ``"0" * 64``).
* ``payload_hash``         — ``payload_hash`` is 64 lowercase hex
                             (structural check; the raw payload
                             never hits the wire).
* ``policy_version``       — ``policy_version`` is present and
                             non-empty. "Retired key" / "unknown
                             policy" checks require a live registry
                             and stay server-side.
* ``execution_coherence``  — ``execution_status`` is terminal
                             (``executed`` or ``failed``).
                             ``pending`` produces
                             ``verification_status="incomplete"``
                             unless ``strict=True``.

Open contract question (flagged on PR #61): the schema's declaration
calls out 18 fields but ``signature`` and ``signing_key_id`` can't
be inside the bytes they cover. This implementation follows v1's
``signed_bytes_for`` precedent — sign the 16-field subset in
declaration order, ship ``signature`` and ``signing_key_id``
alongside. Clarification needed before v2 GA.
"""

from __future__ import annotations

import base64
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .canonicalize import canonicalize_payload
from .types import (
    Proof,
    ProofCheckName,
    ProofFailureReason,
    ProofVerificationCheck,
    ProofVerificationStatus,
)

GENESIS_HASH = "0" * 64
_HASH_HEX = re.compile(r"^[0-9a-f]{64}$")

# The 16 Proof fields covered by the Ed25519 signature, in canonical
# envelope order. Derived from contract/schemas/v2/proof.schema.json
# declaration order with ``signature`` and ``signing_key_id`` removed.
# Reordering here is a breaking change — matches v1's signed_bytes_for.
SIGNED_ENVELOPE_FIELDS: tuple[str, ...] = (
    "proof_id",
    "permit_id",
    "org_id",
    "agent",
    "action",
    "target",
    "payload_hash",
    "policy_version",
    "decision",
    "execution_status",
    "execution_hash",
    "audit_hash",
    "previous_hash",
    "chain_hash",
    "issued_at",
    "consumed_at",
)


@dataclass(frozen=True)
class VerifyKey:
    """A public key the verifier will try, tagged with its registry id."""

    key_id: str
    public_key: Ed25519PublicKey


@dataclass
class ProofVerificationEntry:
    """One proof's verification outcome."""

    proof_id: str
    verification_status: ProofVerificationStatus
    checks: list[ProofVerificationCheck]
    signing_key_id: str | None = None
    reason: str | None = None


@dataclass
class ProofBundleVerificationResult:
    """Aggregate result across a whole bundle."""

    passed: int = 0
    failed: int = 0
    incomplete: int = 0
    proofs: list[ProofVerificationEntry] = field(default_factory=list)


# ── Public API ────────────────────────────────────────────────────────


def signed_bytes_for_proof(proof: Proof | dict[str, Any]) -> bytes:
    """Recreate the exact bytes covered by the Ed25519 signature.

    Accepts either a :class:`Proof` pydantic instance or the raw dict
    shape the server emits. The dict path matters for byte-perfect
    round-trips of unknown fields that a forward-compatible server
    might add — pydantic's ``model_dump`` on ``Proof`` with
    ``extra="allow"`` preserves them, so both paths produce the same
    output today.
    """
    if isinstance(proof, Proof):
        source = proof.model_dump(mode="json")
    else:
        source = proof
    envelope = {field: source.get(field) for field in SIGNED_ENVELOPE_FIELDS}
    return canonicalize_payload(envelope).encode("utf-8")


def verify_proof(
    proof: Proof | dict[str, Any],
    keys: Iterable[VerifyKey],
    previous_chain_hash: str | None,
    strict: bool = False,
) -> ProofVerificationEntry:
    """Verify a single proof.

    ``previous_chain_hash`` is the prior proof's ``chain_hash``
    (or ``"0" * 64`` for genesis). Pass ``None`` to skip the
    ``chain_link`` check — appropriate for standalone proofs outside
    any bundle context.
    """
    keys_list = list(keys)
    proof_dict = _to_dict(proof)
    checks: list[ProofVerificationCheck] = []

    # 1. signature
    sig_check, matched_key_id = _verify_signature(proof_dict, keys_list)
    checks.append(sig_check)

    # 2. chain_link
    checks.append(_check_chain_link(proof_dict, previous_chain_hash))

    # 3. payload_hash (structural)
    checks.append(_check_payload_hash_format(proof_dict))

    # 4. policy_version (non-empty)
    checks.append(_check_policy_version_present(proof_dict))

    # 5. execution_coherence
    exec_check, pending = _check_execution_coherence(proof_dict, strict)
    checks.append(exec_check)

    # Roll up.
    non_exec_failed = any(
        not c.passed and c.name != "execution_coherence" for c in checks
    )
    if non_exec_failed:
        status: ProofVerificationStatus = "invalid"
    elif pending and not strict:
        status = "incomplete"
    elif exec_check.passed:
        status = "valid"
    else:
        status = "invalid"

    return ProofVerificationEntry(
        proof_id=str(proof_dict.get("proof_id", "")),
        verification_status=status,
        checks=checks,
        signing_key_id=matched_key_id,
        reason=_summarize(status, checks),
    )


def replay_proof_bundle(
    bundle: Iterable[Proof | dict[str, Any]],
    keys: Iterable[VerifyKey],
    strict: bool = False,
) -> ProofBundleVerificationResult:
    """Walk a bundle of proofs, threading ``chain_hash`` adjacency.

    Returns a :class:`ProofBundleVerificationResult` with per-proof
    outcomes plus aggregate ``passed`` / ``failed`` / ``incomplete``
    counts. CI audit jobs assert ``result.failed == 0`` and move on.
    """
    keys_list = list(keys)
    result = ProofBundleVerificationResult()
    prev: str | None = GENESIS_HASH
    for proof in bundle:
        entry = verify_proof(proof, keys_list, prev, strict=strict)
        result.proofs.append(entry)
        if entry.verification_status == "valid":
            result.passed += 1
        elif entry.verification_status == "incomplete":
            result.incomplete += 1
        else:
            result.failed += 1
        prev = str(_to_dict(proof).get("chain_hash", GENESIS_HASH))
    return result


def load_verify_keys(public_keys_pem: Iterable[str]) -> list[VerifyKey]:
    """Convenience loader: parse a sequence of SPKI-PEM Ed25519 keys.

    Each key is tagged with ``pem_<i>`` so the registry-id hint can
    still fall back to the loader's order. Callers that have
    registry ids should build ``VerifyKey`` instances directly.
    """
    out: list[VerifyKey] = []
    for i, pem in enumerate(public_keys_pem):
        try:
            loaded = serialization.load_pem_public_key(pem.encode("utf-8"))
        except ValueError:
            continue
        if isinstance(loaded, Ed25519PublicKey):
            out.append(VerifyKey(key_id=f"pem_{i}", public_key=loaded))
    return out


# ── Internals ─────────────────────────────────────────────────────────


def _to_dict(proof: Proof | dict[str, Any]) -> dict[str, Any]:
    if isinstance(proof, Proof):
        return proof.model_dump(mode="json")
    return dict(proof)


def _verify_signature(
    proof: dict[str, Any],
    keys: list[VerifyKey],
) -> tuple[ProofVerificationCheck, str | None]:
    check_name: ProofCheckName = "signature"
    if not keys:
        return _failed(check_name, "invalid_signature"), None
    raw_sig = proof.get("signature")
    if not isinstance(raw_sig, str) or not raw_sig:
        return _failed(check_name, "invalid_signature"), None

    try:
        sig_bytes = _b64url_decode(raw_sig)
    except (ValueError, TypeError):
        return _failed(check_name, "invalid_signature"), None
    envelope = signed_bytes_for_proof(proof)

    hint = proof.get("signing_key_id")
    if isinstance(hint, str) and hint:
        ordered = [k for k in keys if k.key_id == hint] + [
            k for k in keys if k.key_id != hint
        ]
    else:
        hint = None
        ordered = list(keys)

    for candidate in ordered:
        try:
            candidate.public_key.verify(sig_bytes, envelope)
        except InvalidSignature:
            continue
        return (
            ProofVerificationCheck(name=check_name, passed=True),
            candidate.key_id,
        )

    reason: ProofFailureReason = (
        "retired_signing_key"
        if hint is not None and not any(k.key_id == hint for k in keys)
        else "invalid_signature"
    )
    return _failed(check_name, reason), None


def _check_chain_link(
    proof: dict[str, Any],
    previous_chain_hash: str | None,
) -> ProofVerificationCheck:
    if previous_chain_hash is None:
        return ProofVerificationCheck(name="chain_link", passed=True)
    prev = proof.get("previous_hash")
    chain = proof.get("chain_hash")
    if not isinstance(prev, str) or prev != previous_chain_hash:
        return _failed("chain_link", "broken_chain")
    if not isinstance(chain, str) or not _HASH_HEX.match(chain):
        return _failed("chain_link", "broken_chain")
    return ProofVerificationCheck(name="chain_link", passed=True)


def _check_payload_hash_format(proof: dict[str, Any]) -> ProofVerificationCheck:
    payload_hash = proof.get("payload_hash")
    if not isinstance(payload_hash, str) or not _HASH_HEX.match(payload_hash):
        return _failed("payload_hash", "payload_hash_mismatch")
    return ProofVerificationCheck(name="payload_hash", passed=True)


def _check_policy_version_present(proof: dict[str, Any]) -> ProofVerificationCheck:
    version = proof.get("policy_version")
    if not isinstance(version, str) or not version:
        return _failed("policy_version", "missing_policy_version")
    return ProofVerificationCheck(name="policy_version", passed=True)


def _check_execution_coherence(
    proof: dict[str, Any],
    strict: bool,
) -> tuple[ProofVerificationCheck, bool]:
    status = proof.get("execution_status")
    if status == "pending":
        if strict:
            return _failed("execution_coherence", "execution_not_consumed"), True
        # Non-strict: surface the state as a non-passing check so the
        # caller can see what's pending, but lift the overall status
        # to "incomplete" rather than "invalid".
        return (
            ProofVerificationCheck(
                name="execution_coherence",
                passed=False,
                reason="execution_not_consumed",
            ),
            True,
        )
    if status == "failed" and proof.get("consumed_at") is None:
        return _failed("execution_coherence", "execution_not_consumed"), False
    return ProofVerificationCheck(name="execution_coherence", passed=True), False


def _summarize(
    status: ProofVerificationStatus,
    checks: list[ProofVerificationCheck],
) -> str | None:
    if status == "valid":
        return None
    failed = next((c for c in checks if not c.passed), None)
    if failed is None:
        return None
    if status == "incomplete":
        return "execution pending"
    return failed.reason or failed.name


def _failed(
    name: ProofCheckName,
    reason: ProofFailureReason,
) -> ProofVerificationCheck:
    return ProofVerificationCheck(name=name, passed=False, reason=reason)


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)
