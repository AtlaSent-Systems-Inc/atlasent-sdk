"""Tests for the pt.v4.* COSE Sign1 offline permit verifier (ADR-050).

Generates real Ed25519 keys via the ``cryptography`` library so each test is
a real sign → verify round-trip.
"""

from __future__ import annotations

import base64
import time
import uuid

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from atlasent.verify_permit_v4 import (
    REASON_BAD_FORMAT,
    REASON_BAD_PREFIX,
    REASON_EXPIRED,
    REASON_SIGNATURE_INVALID,
    REASON_WRONG_PROTECTED_HEADER,
    PermitClaimsV4,
    PermitV4VerifyError,
    verify_permit_v4,
)

# ─── CBOR helpers for token construction ──────────────────────────────────────

def _cbor_uint(n: int) -> bytes:
    if n <= 23:
        return bytes([n])
    if n <= 0xFF:
        return bytes([24, n])
    if n <= 0xFFFF:
        return bytes([25, n >> 8, n & 0xFF])
    return bytes([26, (n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF])


def _cbor_nint(v: int) -> bytes:
    b = bytearray(_cbor_uint(v))
    b[0] |= 0x20
    return bytes(b)


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


def _uuid_to_bytes(s: str) -> bytes:
    return uuid.UUID(s).bytes


def _hex_to_bytes(h: str) -> bytes:
    return bytes.fromhex(h)


PROTECTED_HEADER = bytes([0xa1, 0x01, 0x27])  # { 1: -8 } = EdDSA


def _build_permit_claims_cbor(claims: PermitClaimsV4) -> bytes:
    entries: list[bytes] = []

    def add(k: bytes, v: bytes) -> None:
        entries.append(k)
        entries.append(v)

    add(_cbor_uint(4), _cbor_uint(claims.exp))
    add(_cbor_uint(6), _cbor_uint(claims.iat))
    add(_cbor_uint(7), _cbor_bstr(_uuid_to_bytes(claims.permit_id)))
    add(_cbor_nint(0), _cbor_tstr(claims.decision_id))
    add(_cbor_nint(1), _cbor_bstr(_uuid_to_bytes(claims.org_id)))
    add(_cbor_nint(2), _cbor_tstr(claims.action_type))
    add(_cbor_nint(3), _cbor_tstr(claims.actor_id))
    add(_cbor_nint(4), _cbor_tstr(claims.environment))
    if claims.cdo_hash:
        add(_cbor_nint(5), _cbor_bstr(_hex_to_bytes(claims.cdo_hash)))
    if claims.policy_hash:
        add(_cbor_nint(6), _cbor_bstr(_hex_to_bytes(claims.policy_hash)))

    count = len(entries) // 2
    map_head = bytearray(_cbor_uint(count))
    map_head[0] |= 0xa0
    return bytes(map_head) + b"".join(entries)


def _build_sig_structure(payload_bytes: bytes) -> bytes:
    return _cbor_array([
        _cbor_tstr("Signature1"),
        _cbor_bstr(PROTECTED_HEADER),
        _cbor_bstr(b""),
        _cbor_bstr(payload_bytes),
    ])


def _build_token(claims: PermitClaimsV4, private_key: Ed25519PrivateKey) -> str:
    payload_bytes = _build_permit_claims_cbor(claims)
    sig_structure = _build_sig_structure(payload_bytes)
    sig = private_key.sign(sig_structure)
    cose_sign1 = (
        bytes([0xd2])  # CBOR tag 18
        + _cbor_array([
            _cbor_bstr(PROTECTED_HEADER),
            bytes([0xa0]),          # empty unprotected map {}
            _cbor_bstr(payload_bytes),
            _cbor_bstr(sig),
        ])
    )
    b64 = base64.urlsafe_b64encode(cose_sign1).rstrip(b"=").decode()
    return f"pt.v4.{b64}"


def _pub_b64(pub: Ed25519PublicKey) -> str:
    return base64.b64encode(pub.public_bytes_raw()).decode()


# ─── Fixtures ─────────────────────────────────────────────────────────────────

NOW = int(time.time())

TEST_CLAIMS = PermitClaimsV4(
    permit_id="12345678-1234-1234-1234-123456789abc",
    exp=NOW + 3600,
    iat=NOW,
    decision_id="87654321-4321-4321-4321-cba987654321",
    org_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    action_type="production.deploy",
    actor_id="agent:deploy-bot",
    environment="live",
)


@pytest.fixture()
def key_pair():
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key()
    return priv, pub


# ─── Tests ────────────────────────────────────────────────────────────────────

def test_verifies_well_formed_token(key_pair):
    priv, pub = key_pair
    token = _build_token(TEST_CLAIMS, priv)
    assert token.startswith("pt.v4.")

    result = verify_permit_v4(token, _pub_b64(pub))
    assert result.ok is True
    assert result.claims.permit_id == TEST_CLAIMS.permit_id
    assert result.claims.action_type == "production.deploy"
    assert result.claims.actor_id == "agent:deploy-bot"
    assert result.claims.org_id == TEST_CLAIMS.org_id
    assert result.claims.decision_id == TEST_CLAIMS.decision_id
    assert result.claims.environment == "live"
    assert result.claims.exp == TEST_CLAIMS.exp
    assert result.claims.iat == TEST_CLAIMS.iat
    assert result.claims.cdo_hash is None
    assert result.claims.policy_hash is None


def test_verifies_token_with_optional_hashes(key_pair):
    priv, pub = key_pair
    claims = PermitClaimsV4(
        **{**vars(TEST_CLAIMS), "cdo_hash": "a" * 64, "policy_hash": "b" * 64}
    )
    token = _build_token(claims, priv)
    result = verify_permit_v4(token, _pub_b64(pub))
    assert result.ok is True
    assert result.claims.cdo_hash == "a" * 64
    assert result.claims.policy_hash == "b" * 64


def test_verifies_test_environment_token(key_pair):
    priv, pub = key_pair
    claims = PermitClaimsV4(**{**vars(TEST_CLAIMS), "environment": "test"})
    token = _build_token(claims, priv)
    result = verify_permit_v4(token, _pub_b64(pub))
    assert result.claims.environment == "test"


def test_rejects_wrong_prefix():
    with pytest.raises(PermitV4VerifyError) as exc_info:
        verify_permit_v4("pt.v3.abc123", "dGVzdA==")
    assert exc_info.value.reason == REASON_BAD_PREFIX


def test_rejects_non_string_token():
    with pytest.raises(PermitV4VerifyError) as exc_info:
        verify_permit_v4(None, "dGVzdA==")  # type: ignore[arg-type]
    assert exc_info.value.reason == REASON_BAD_FORMAT


def test_rejects_invalid_base64url():
    with pytest.raises(PermitV4VerifyError) as exc_info:
        verify_permit_v4("pt.v4.!!!notbase64!!!", "dGVzdA==")
    assert exc_info.value.reason == REASON_BAD_FORMAT


def test_rejects_wrong_signing_key(key_pair):
    priv, _pub = key_pair
    other_priv = Ed25519PrivateKey.generate()
    other_pub = other_priv.public_key()

    token = _build_token(TEST_CLAIMS, priv)
    with pytest.raises(PermitV4VerifyError) as exc_info:
        verify_permit_v4(token, _pub_b64(other_pub))
    assert exc_info.value.reason == REASON_SIGNATURE_INVALID


def test_rejects_tampered_payload(key_pair):
    priv, pub = key_pair
    token = _build_token(TEST_CLAIMS, priv)

    # Decode, flip a byte, re-encode.
    b64 = token[len("pt.v4."):]
    padded = b64.replace("-", "+").replace("_", "/") + "==" [: (-len(b64) % 4) or 4]
    raw = bytearray(base64.b64decode(padded))
    raw[len(raw) // 2] ^= 0xFF
    tampered = "pt.v4." + base64.urlsafe_b64encode(bytes(raw)).rstrip(b"=").decode()

    with pytest.raises(PermitV4VerifyError):
        verify_permit_v4(tampered, _pub_b64(pub))


def test_accepts_unexpired_with_check_expiry(key_pair):
    priv, pub = key_pair
    token = _build_token(TEST_CLAIMS, priv)
    result = verify_permit_v4(token, _pub_b64(pub), check_expiry=True)
    assert result.ok is True


def test_rejects_expired_with_check_expiry(key_pair):
    priv, pub = key_pair
    expired_claims = PermitClaimsV4(**{**vars(TEST_CLAIMS), "exp": NOW - 3600})
    token = _build_token(expired_claims, priv)
    with pytest.raises(PermitV4VerifyError) as exc_info:
        verify_permit_v4(token, _pub_b64(pub), check_expiry=True)
    assert exc_info.value.reason == REASON_EXPIRED


def test_accepts_expired_without_check_expiry(key_pair):
    priv, pub = key_pair
    expired_claims = PermitClaimsV4(**{**vars(TEST_CLAIMS), "exp": NOW - 3600})
    token = _build_token(expired_claims, priv)
    result = verify_permit_v4(token, _pub_b64(pub))
    assert result.ok is True
    assert result.claims.exp == NOW - 3600


def test_rejects_wrong_protected_header(key_pair):
    priv, pub = key_pair
    payload_bytes = _build_permit_claims_cbor(TEST_CLAIMS)
    # Build COSE_Sign1 with wrong protected header { 1: -7 } = ES256
    wrong_protected = bytes([0xa1, 0x01, 0x26])
    sig_structure = _cbor_array([
        _cbor_tstr("Signature1"),
        _cbor_bstr(wrong_protected),
        _cbor_bstr(b""),
        _cbor_bstr(payload_bytes),
    ])
    sig = priv.sign(sig_structure)
    cose_sign1 = (
        bytes([0xd2])
        + _cbor_array([
            _cbor_bstr(wrong_protected),
            bytes([0xa0]),
            _cbor_bstr(payload_bytes),
            _cbor_bstr(sig),
        ])
    )
    b64 = base64.urlsafe_b64encode(cose_sign1).rstrip(b"=").decode()
    token = f"pt.v4.{b64}"
    with pytest.raises(PermitV4VerifyError) as exc_info:
        verify_permit_v4(token, _pub_b64(pub))
    assert exc_info.value.reason == REASON_WRONG_PROTECTED_HEADER
