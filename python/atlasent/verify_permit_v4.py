"""Offline verifier for pt.v4.* COSE Sign1 permit tokens (ADR-050).

``pt.v4.{base64url(COSE_Sign1_bytes)}`` where COSE_Sign1_bytes is a
CBOR-encoded COSE_Sign1 structure (RFC 9052, CBOR tag 18)::

    #6.18([bstr(protected_header), {}, bstr(permit_claims_cbor), bstr(sig)])

The bytes signed by Ed25519 are the COSE Sig_Structure (RFC 9052 §4.4)::

    ["Signature1", bstr(protected_header), bstr(""), bstr(permit_claims_cbor)]

Protected header: ``{ 1: -8 }`` = ``0xa1 0x01 0x27`` (EdDSA, RFC 8037).
Permit claims: CBOR integer-keyed map with keys 4, 6, 7, -1 .. -7.

Offline by design: with a pinned Ed25519 public key (raw 32 bytes,
standard base64) this function needs no network.  It is the Python mirror of
the TypeScript ``verifyPermitV4`` in ``typescript/src/verify-permit-v4.ts``.

Requires the ``cryptography`` library (already a dependency of the SDK).
"""

from __future__ import annotations

import base64
import struct
import uuid as _uuid_module
from dataclasses import dataclass
from typing import Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


# ─── Error types ──────────────────────────────────────────────────────────────

REASON_BAD_FORMAT = "bad_format"
REASON_BAD_PREFIX = "bad_prefix"
REASON_COSE_DECODE_FAILED = "cose_decode_failed"
REASON_WRONG_PROTECTED_HEADER = "wrong_protected_header"
REASON_CLAIMS_DECODE_FAILED = "claims_decode_failed"
REASON_SIGNATURE_INVALID = "signature_invalid"
REASON_EXPIRED = "expired"


class PermitV4VerifyError(Exception):
    """Raised when a pt.v4.* permit fails verification. ``reason`` is stable."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(f"{reason}: {message}")
        self.reason = reason


# ─── Permit claims dataclass ──────────────────────────────────────────────────

@dataclass
class PermitClaimsV4:
    permit_id: str    # UUID string (from key 7 / CWT cti — 16-byte bstr)
    exp: int          # Unix epoch seconds (key 4)
    iat: int          # Unix epoch seconds (key 6)
    decision_id: str  # tstr (key -1)
    org_id: str       # UUID string (key -2 — 16-byte bstr)
    action_type: str  # tstr (key -3)
    actor_id: str     # tstr (key -4)
    environment: str  # "live" | "test" (key -5)
    cdo_hash: Optional[str] = None    # 64-char hex sha256 (key -6, optional)
    policy_hash: Optional[str] = None # 64-char hex sha256 (key -7, optional)


@dataclass
class PermitV4VerifyResult:
    ok: bool
    claims: PermitClaimsV4


# ─── Minimal CBOR reader ──────────────────────────────────────────────────────

class _CborReader:
    def __init__(self, data: bytes) -> None:
        self._b = data
        self._pos = 0

    def _read_byte(self) -> int:
        if self._pos >= len(self._b):
            raise ValueError("cbor: unexpected end")
        b = self._b[self._pos]
        self._pos += 1
        return b

    def _read_uint_val(self, add: int) -> int:
        if add <= 23:
            return add
        if add == 24:
            return self._read_byte()
        if add == 25:
            hi = self._read_byte()
            lo = self._read_byte()
            return (hi << 8) | lo
        if add == 26:
            a, b, c, d = (self._read_byte() for _ in range(4))
            return (a << 24) | (b << 16) | (c << 8) | d
        raise ValueError(f"cbor: unsupported additional value {add}")

    def _read_head(self) -> tuple[int, int]:
        b = self._read_byte()
        major = (b >> 5) & 7
        n = self._read_uint_val(b & 0x1f)
        return major, n

    def read_bstr(self) -> bytes:
        major, n = self._read_head()
        if major != 2:
            raise ValueError(f"cbor: expected bstr, got major {major}")
        out = self._b[self._pos:self._pos + n]
        self._pos += n
        return out

    def read_array_len(self) -> int:
        major, n = self._read_head()
        if major != 4:
            raise ValueError(f"cbor: expected array, got major {major}")
        return n

    def read_map_len(self) -> int:
        major, n = self._read_head()
        if major != 5:
            raise ValueError(f"cbor: expected map, got major {major}")
        return n

    def read_int(self) -> int:
        major, n = self._read_head()
        if major == 0:
            return n
        if major == 1:
            return -1 - n
        raise ValueError(f"cbor: expected int, got major {major}")

    def read_tstr(self) -> str:
        major, n = self._read_head()
        if major != 3:
            raise ValueError(f"cbor: expected tstr, got major {major}")
        out = self._b[self._pos:self._pos + n]
        self._pos += n
        return out.decode("utf-8")

    def skip(self) -> None:
        major, n = self._read_head()
        if major <= 1:
            return
        if major in (2, 3):
            self._pos += n
            return
        if major == 4:
            for _ in range(n):
                self.skip()
            return
        if major == 5:
            for _ in range(n * 2):
                self.skip()
            return
        if major == 6:
            self.skip()
            return
        raise ValueError(f"cbor: unsupported major {major}")

    def peek_major(self) -> int:
        return (self._b[self._pos] >> 5) & 7

    def read_tag_num(self) -> int:
        major, n = self._read_head()
        if major != 6:
            raise ValueError(f"cbor: expected tag, got major {major}")
        return n


# ─── CBOR encoding helpers (for Sig_Structure) ───────────────────────────────

def _cbor_uint(n: int) -> bytes:
    if n <= 23:
        return bytes([n])
    if n <= 0xff:
        return bytes([24, n])
    if n <= 0xffff:
        return bytes([25, n >> 8, n & 0xff])
    return bytes([26, (n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])


def _cbor_bstr(b: bytes) -> bytes:
    head = bytearray(_cbor_uint(len(b)))
    head[0] |= 0x40
    return bytes(head) + b


def _cbor_tstr(s: str) -> bytes:
    b = s.encode("utf-8")
    head = bytearray(_cbor_uint(len(b)))
    head[0] |= 0x60
    return bytes(head) + b


def _cbor_array(items: list[bytes]) -> bytes:
    head = bytearray(_cbor_uint(len(items)))
    head[0] |= 0x80
    return bytes(head) + b"".join(items)


# ─── Protected header ─────────────────────────────────────────────────────────

_PROTECTED_HEADER = bytes([0xa1, 0x01, 0x27])  # { 1: -8 } = EdDSA


# ─── COSE Sign1 decode ────────────────────────────────────────────────────────

def _decode_cose_sign1(data: bytes) -> tuple[bytes, bytes, bytes]:
    """Return (protected_bytes, payload_bytes, sig_bytes)."""
    r = _CborReader(data)
    if r.peek_major() == 6:
        r.read_tag_num()  # optional tag 18
    length = r.read_array_len()
    if length != 4:
        raise ValueError(f"cose: expected 4-element array, got {length}")
    protected_bytes = r.read_bstr()
    r.skip()  # unprotected map {}
    payload_bytes = r.read_bstr()
    sig = r.read_bstr()
    return protected_bytes, payload_bytes, sig


def _build_sig_structure(protected_bytes: bytes, payload_bytes: bytes) -> bytes:
    """Build the COSE Sig_Structure for signing/verification (RFC 9052 §4.4)."""
    return _cbor_array([
        _cbor_tstr("Signature1"),
        _cbor_bstr(protected_bytes),
        _cbor_bstr(b""),
        _cbor_bstr(payload_bytes),
    ])


# ─── Permit claims decode ─────────────────────────────────────────────────────

def _bytes_to_uuid(b: bytes) -> str:
    return str(_uuid_module.UUID(bytes=b))


def _decode_permit_claims(data: bytes) -> PermitClaimsV4:
    r = _CborReader(data)
    length = r.read_map_len()
    result: dict = {}
    for _ in range(length):
        key = r.read_int()
        if key == 4:
            result["exp"] = r.read_int()
        elif key == 6:
            result["iat"] = r.read_int()
        elif key == 7:
            result["permit_id"] = _bytes_to_uuid(r.read_bstr())
        elif key == -1:
            result["decision_id"] = r.read_tstr()
        elif key == -2:
            result["org_id"] = _bytes_to_uuid(r.read_bstr())
        elif key == -3:
            result["action_type"] = r.read_tstr()
        elif key == -4:
            result["actor_id"] = r.read_tstr()
        elif key == -5:
            result["environment"] = r.read_tstr()
        elif key == -6:
            result["cdo_hash"] = r.read_bstr().hex()
        elif key == -7:
            result["policy_hash"] = r.read_bstr().hex()
        else:
            r.skip()

    required = ("exp", "iat", "permit_id", "decision_id", "org_id", "action_type", "actor_id", "environment")
    for f in required:
        if f not in result:
            raise ValueError(f"missing required claim: {f}")

    return PermitClaimsV4(
        permit_id=result["permit_id"],
        exp=result["exp"],
        iat=result["iat"],
        decision_id=result["decision_id"],
        org_id=result["org_id"],
        action_type=result["action_type"],
        actor_id=result["actor_id"],
        environment=result["environment"],
        cdo_hash=result.get("cdo_hash"),
        policy_hash=result.get("policy_hash"),
    )


# ─── Main API ─────────────────────────────────────────────────────────────────

def verify_permit_v4(
    token: str,
    public_key_b64: str,
    *,
    check_expiry: bool = False,
) -> PermitV4VerifyResult:
    """Verify a pt.v4.* COSE Sign1 permit token offline.

    Decodes the base64url payload, verifies the EdDSA signature against the
    supplied Ed25519 public key (raw 32 bytes, standard base64), and returns
    the decoded permit claims.

    Does NOT verify ``exp`` unless ``check_expiry=True``.  The permit may
    still be revoked server-side even when this returns ``ok=True``.

    Args:
        token:          Full ``pt.v4.*`` token string.
        public_key_b64: Raw 32-byte Ed25519 public key, standard base64.
        check_expiry:   If True, raises if ``claims.exp ≤ now`` (default False).

    Returns:
        :class:`PermitV4VerifyResult` with ``ok=True`` and the decoded claims.

    Raises:
        :class:`PermitV4VerifyError` on any verification failure.
    """
    import time as _time

    if not isinstance(token, str):
        raise PermitV4VerifyError(REASON_BAD_FORMAT, "token must be a string")
    if not token.startswith("pt.v4."):
        raise PermitV4VerifyError(REASON_BAD_PREFIX, f"expected pt.v4.* prefix, got: {token[:12]!r}")

    b64_payload = token[len("pt.v4."):]
    # base64url → standard base64
    padded = b64_payload.replace("-", "+").replace("_", "/")
    padded += "=" * (-len(padded) % 4)
    try:
        cose_bytes = base64.b64decode(padded)
    except Exception as exc:
        raise PermitV4VerifyError(REASON_BAD_FORMAT, f"base64url decode failed: {exc}") from exc

    try:
        protected_bytes, payload_bytes, sig = _decode_cose_sign1(cose_bytes)
    except Exception as exc:
        raise PermitV4VerifyError(REASON_COSE_DECODE_FAILED, str(exc)) from exc

    if protected_bytes != _PROTECTED_HEADER:
        raise PermitV4VerifyError(
            REASON_WRONG_PROTECTED_HEADER,
            "expected EdDSA protected header { 1: -8 } = 0xa1 0x01 0x27",
        )

    try:
        claims = _decode_permit_claims(payload_bytes)
    except Exception as exc:
        raise PermitV4VerifyError(REASON_CLAIMS_DECODE_FAILED, str(exc)) from exc

    to_verify = _build_sig_structure(protected_bytes, payload_bytes)
    try:
        raw_key = base64.b64decode(public_key_b64)
        pub_key = Ed25519PublicKey.from_public_bytes(raw_key)
        pub_key.verify(sig, to_verify)
    except InvalidSignature:
        raise PermitV4VerifyError(REASON_SIGNATURE_INVALID, "Ed25519 signature did not verify")
    except Exception as exc:
        raise PermitV4VerifyError(REASON_SIGNATURE_INVALID, f"key or signature error: {exc}") from exc

    if check_expiry:
        now_sec = int(_time.time())
        if claims.exp <= now_sec:
            from datetime import datetime, timezone
            exp_str = datetime.fromtimestamp(claims.exp, tz=timezone.utc).isoformat()
            raise PermitV4VerifyError(REASON_EXPIRED, f"permit expired at {exp_str}")

    return PermitV4VerifyResult(ok=True, claims=claims)
