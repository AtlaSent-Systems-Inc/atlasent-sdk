#!/usr/bin/env node
// Offline verification of an AtlaSent evidence bundle or pt.v4.* permit token
// (Node, zero dependencies).
//
// Uses ONLY the Node standard library (`node:crypto`, `node:fs`). There is
// nothing to `npm install` and nothing to trust beyond Node itself and this
// file, which you can read top to bottom in a couple of minutes. It contacts
// no network and is deterministic for the same input.
//
// Evidence bundle algorithm (see docs/02-hash-chain.md and docs/03-cryptographic-assumptions.md):
//   1. Signature : Ed25519 over sha256(canonical_json(bundle without `signature`)).
//   2. Chain     : each record.entry_hash == sha256(prev_hash_bytes || canonical
//                  payload); prev_hash links the chain; anchors match chain_context.
//   3. Summary   : summary_hash == RFC 6962 Merkle root over the entry_hash leaves.
//
// pt.v4.* permit algorithm (ADR-050):
//   Token format : pt.v4.{base64url(COSE_Sign1_bytes)}
//   COSE_Sign1   : CBOR tag 18 + [bstr(protected), {}, bstr(payload), bstr(sig)]
//   Protected    : { 1: -8 } = EdDSA (0xa1 0x01 0x27)
//   Sig_Structure: ["Signature1", bstr(protected), bstr(""), bstr(payload)]
//   Verify       : Ed25519 over Sig_Structure bytes
//
// Usage:
//   node verify.mjs [bundle.json] [trust-root.json]
//   node verify.mjs --permit <pt.v4.*token> <public_key_b64> [--check-expiry]
//
// Exit:   0 = PASS (all checks), 1 = FAIL, 2 = usage/read error.

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

class VerifyError extends Error {}

/** Recursively key-sorted, compact JSON — the twin of the SDK's canonicalJson. */
function canonicalJson(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new VerifyError("floating-point values are not canonicalizable in v1");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",") + "}";
  }
  throw new VerifyError(`uncanonicalizable type: ${typeof value}`);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest();
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** entry_hash = sha256( prev_hash_bytes || canonical_json(record sans entry_hash/signature) ). */
function recordEntryHash(record) {
  const content = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== "entry_hash" && k !== "signature") content[k] = v;
  }
  const prevBytes = Buffer.from(record.prev_hash, "hex");
  return sha256hex(Buffer.concat([prevBytes, Buffer.from(canonicalJson(content), "utf8")]));
}

/** RFC 6962 Merkle root (hex) over hex-string leaves. */
function merkleRootHex(leafHexes) {
  if (leafHexes.length === 0) return sha256hex(Buffer.alloc(0));
  let level = leafHexes.map((h) => sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(h, "hex")])));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha256(Buffer.concat([Buffer.from([0x01]), level[i], level[i + 1]])));
      } else {
        next.push(level[i]); // odd node promoted
      }
    }
    level = next;
  }
  return level[0].toString("hex");
}

/** Import a raw 32-byte Ed25519 public key (standard base64) as a KeyObject. */
function ed25519PublicKey(publicKeyB64) {
  const raw = Buffer.from(publicKeyB64, "base64");
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

function resolveKey(keySet, keyId) {
  for (const k of keySet.issuing_keys ?? []) {
    if (k.key_id === keyId) {
      if (k.alg !== "Ed25519") throw new VerifyError(`unsupported key alg: ${k.alg}`);
      return ed25519PublicKey(k.public_key_b64);
    }
  }
  throw new VerifyError(`unknown_key_id: key_id not in key set: ${keyId}`);
}

function require_(cond, message) {
  if (!cond) throw new VerifyError(message);
}

// ─── Minimal CBOR reader/writer for pt.v4.* COSE Sign1 (no external deps) ───

class CborReader {
  constructor(buf) { this._b = buf; this._pos = 0; }

  _byte() {
    if (this._pos >= this._b.length) throw new VerifyError("cbor: unexpected end");
    return this._b[this._pos++];
  }

  _readUintVal(add) {
    if (add <= 23) return add;
    if (add === 24) return this._byte();
    if (add === 25) { const h = this._byte(), l = this._byte(); return (h << 8) | l; }
    if (add === 26) {
      const a = this._byte(), b = this._byte(), c = this._byte(), d = this._byte();
      return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    }
    throw new VerifyError(`cbor: unsupported additional value ${add}`);
  }

  _head() { const b = this._byte(); return { major: (b >> 5) & 7, n: this._readUintVal(b & 0x1f) }; }

  readBstr() {
    const { major, n } = this._head();
    if (major !== 2) throw new VerifyError(`cbor: expected bstr, got major ${major}`);
    const out = this._b.slice(this._pos, this._pos + n);
    this._pos += n;
    return out;
  }

  readTstr() {
    const { major, n } = this._head();
    if (major !== 3) throw new VerifyError(`cbor: expected tstr, got major ${major}`);
    const out = this._b.slice(this._pos, this._pos + n);
    this._pos += n;
    return out.toString("utf8");
  }

  readArrayLen() {
    const { major, n } = this._head();
    if (major !== 4) throw new VerifyError(`cbor: expected array, got major ${major}`);
    return n;
  }

  readMapLen() {
    const { major, n } = this._head();
    if (major !== 5) throw new VerifyError(`cbor: expected map, got major ${major}`);
    return n;
  }

  readInt() {
    const { major, n } = this._head();
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    throw new VerifyError(`cbor: expected int, got major ${major}`);
  }

  readTagNum() {
    const { major, n } = this._head();
    if (major !== 6) throw new VerifyError(`cbor: expected tag, got major ${major}`);
    return n;
  }

  peekMajor() { return (this._b[this._pos] >> 5) & 7; }

  skip() {
    const { major, n } = this._head();
    if (major <= 1) return;
    if (major === 2 || major === 3) { this._pos += n; return; }
    if (major === 4) { for (let i = 0; i < n; i++) this.skip(); return; }
    if (major === 5) { for (let i = 0; i < n * 2; i++) this.skip(); return; }
    if (major === 6) { this.skip(); return; }
    throw new VerifyError(`cbor: unsupported major ${major}`);
  }
}

function _cborUint(n) {
  if (n <= 23) return Buffer.from([n]);
  if (n <= 0xff) return Buffer.from([24, n]);
  if (n <= 0xffff) return Buffer.from([25, n >> 8, n & 0xff]);
  return Buffer.from([26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function _cborBstr(b) {
  const head = Buffer.from(_cborUint(b.length));
  head[0] |= 0x40;
  return Buffer.concat([head, b]);
}

function _cborTstr(s) {
  const b = Buffer.from(s, "utf8");
  const head = Buffer.from(_cborUint(b.length));
  head[0] |= 0x60;
  return Buffer.concat([head, b]);
}

function _cborArray(items) {
  const head = Buffer.from(_cborUint(items.length));
  head[0] |= 0x80;
  return Buffer.concat([head, ...items]);
}

/** Build the COSE Sig_Structure (RFC 9052 §4.4) — the bytes Ed25519 signs/verifies. */
function _buildSigStructure(protectedBytes, payloadBytes) {
  return _cborArray([
    _cborTstr("Signature1"),
    _cborBstr(protectedBytes),
    _cborBstr(Buffer.alloc(0)),
    _cborBstr(payloadBytes),
  ]);
}

function _uuidFromBytes(buf) {
  const h = buf.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const _PROTECTED_HEADER_V4 = Buffer.from([0xa1, 0x01, 0x27]); // { 1: -8 } = EdDSA

function _decodeCoseSign1(coseBytes) {
  const r = new CborReader(coseBytes);
  if (r.peekMajor() === 6) r.readTagNum(); // optional CBOR tag 18
  const len = r.readArrayLen();
  if (len !== 4) throw new VerifyError(`cose: expected 4-element array, got ${len}`);
  const protectedBytes = r.readBstr();
  r.skip(); // unprotected header {}
  const payloadBytes = r.readBstr();
  const sig = r.readBstr();
  return { protectedBytes, payloadBytes, sig };
}

function _decodePermitClaims(data) {
  const r = new CborReader(data);
  const len = r.readMapLen();
  const m = {};
  for (let i = 0; i < len; i++) {
    const key = r.readInt();
    switch (key) {
      case  4: m.exp          = r.readInt();                          break;
      case  6: m.iat          = r.readInt();                          break;
      case  7: m.permit_id    = _uuidFromBytes(r.readBstr());         break;
      case -1: m.decision_id  = r.readTstr();                         break;
      case -2: m.org_id       = _uuidFromBytes(r.readBstr());         break;
      case -3: m.action_type  = r.readTstr();                         break;
      case -4: m.actor_id     = r.readTstr();                         break;
      case -5: m.environment  = r.readTstr();                         break;
      case -6: m.cdo_hash     = r.readBstr().toString("hex");         break;
      case -7: m.policy_hash  = r.readBstr().toString("hex");         break;
      default: r.skip(); break;
    }
  }
  const required = ["exp", "iat", "permit_id", "decision_id", "org_id", "action_type", "actor_id", "environment"];
  for (const f of required) {
    if (!(f in m)) throw new VerifyError(`missing required claim: ${f}`);
  }
  return m;
}

// ─── pt.v4.* offline verifier (ADR-050) ──────────────────────────────────────

/**
 * Verify a pt.v4.* COSE Sign1 permit token offline.
 *
 * Decodes the base64url payload, verifies the EdDSA signature against the
 * supplied Ed25519 public key (raw 32 bytes, standard base64), and returns
 * the decoded permit claims.
 *
 * Throws VerifyError on any failure; the message is prefixed with the
 * failure reason code (bad_format, bad_prefix, cose_decode_failed,
 * wrong_protected_header, claims_decode_failed, signature_invalid, expired).
 */
function verifyPermitV4(token, publicKeyB64, { checkExpiry = false } = {}) {
  if (typeof token !== "string") {
    throw new VerifyError("bad_format: token must be a string");
  }
  if (!token.startsWith("pt.v4.")) {
    throw new VerifyError(`bad_prefix: expected pt.v4.* prefix, got: ${String(token).slice(0, 12)}`);
  }

  const b64 = token.slice("pt.v4.".length).replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  let coseBytes;
  try {
    coseBytes = Buffer.from(padded, "base64");
    if (coseBytes.length === 0) throw new Error("empty");
  } catch {
    throw new VerifyError("bad_format: base64url decode failed");
  }

  let protectedBytes, payloadBytes, sig;
  try {
    ({ protectedBytes, payloadBytes, sig } = _decodeCoseSign1(coseBytes));
  } catch (err) {
    if (err instanceof VerifyError) throw new VerifyError(`cose_decode_failed: ${err.message}`);
    throw err;
  }

  if (!protectedBytes.equals(_PROTECTED_HEADER_V4)) {
    throw new VerifyError("wrong_protected_header: expected EdDSA { 1: -8 } = 0xa1 0x01 0x27");
  }

  let claims;
  try {
    claims = _decodePermitClaims(payloadBytes);
  } catch (err) {
    if (err instanceof VerifyError) throw new VerifyError(`claims_decode_failed: ${err.message}`);
    throw err;
  }

  const toVerify = _buildSigStructure(protectedBytes, payloadBytes);
  let pubkey;
  try {
    pubkey = ed25519PublicKey(publicKeyB64);
  } catch {
    throw new VerifyError("signature_invalid: cannot import public key");
  }
  const ok = edVerify(null, toVerify, pubkey, sig);
  if (!ok) throw new VerifyError("signature_invalid: Ed25519 signature did not verify");

  if (checkExpiry) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (claims.exp <= nowSec) {
      throw new VerifyError(`expired: permit expired at ${new Date(claims.exp * 1000).toISOString()}`);
    }
  }

  return { ok: true, claims };
}

// ─── Evidence bundle verifier ─────────────────────────────────────────────────

function verifyEvidenceBundle(bundle, keySet) {
  if (typeof bundle !== "object" || bundle === null) throw new VerifyError("bundle is not an object");
  for (const f of ["records", "chain_context", "summary_hash", "signature"]) {
    require_(f in bundle, `missing field: ${f}`);
  }

  const sig = bundle.signature;
  require_(sig && typeof sig === "object", "signature is not an object");
  require_(sig.alg === "Ed25519", "unsupported signature alg");
  for (const f of ["key_id", "signature_b64"]) require_(f in sig, `missing signature.${f}`);

  // 1. Signature over canonical bytes (signature field omitted), SHA-256 then Ed25519.
  const pubkey = resolveKey(keySet, sig.key_id);
  const signingInput = {};
  for (const [k, v] of Object.entries(bundle)) if (k !== "signature") signingInput[k] = v;
  const digest = sha256(Buffer.from(canonicalJson(signingInput), "utf8"));
  const ok = edVerify(null, digest, pubkey, Buffer.from(sig.signature_b64, "base64"));
  require_(ok, "signature_invalid: Ed25519 signature did not verify");

  // 2. Chain binding.
  const records = bundle.records;
  const chain = bundle.chain_context;
  require_(Array.isArray(records) && records.length > 0, "no records");
  require_(chain.entry_count === records.length, "chain_context.entry_count != number of records");
  let prev = chain.first_prev_hash;
  records.forEach((rec, i) => {
    require_(recordEntryHash(rec) === rec.entry_hash, `record[${i}].entry_hash does not match recomputed content hash`);
    require_(rec.prev_hash === prev, `record[${i}].prev_hash does not link to the prior entry`);
    prev = rec.entry_hash;
  });
  require_(records[0].entry_hash === chain.first_entry_hash, "chain_context.first_entry_hash mismatch");
  require_(records[records.length - 1].entry_hash === chain.last_entry_hash, "chain_context.last_entry_hash mismatch");

  // 3. summary_hash = RFC 6962 Merkle root over record entry_hash leaves.
  const expectedRoot = merkleRootHex(records.map((r) => r.entry_hash));
  require_(expectedRoot === bundle.summary_hash, "summary_hash_mismatch: recomputed Merkle root does not match summary_hash");

  return {
    ok: true,
    bundle_id: bundle.bundle_id,
    key_id: sig.key_id,
    record_count: records.length,
    checks: ["signature", "chain_binding", "summary_hash"],
  };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  // --permit mode: node verify.mjs --permit <pt.v4.*> <pubkey_b64> [--check-expiry]
  if (args.includes("--permit")) {
    const pIdx = args.indexOf("--permit");
    const token = args[pIdx + 1];
    const pubKeyB64 = args[pIdx + 2];
    const checkExpiry = args.includes("--check-expiry");

    if (!token || !pubKeyB64 || token.startsWith("--") || pubKeyB64.startsWith("--")) {
      console.error("usage: node verify.mjs --permit <pt.v4.*token> <public_key_b64> [--check-expiry]");
      return 2;
    }

    try {
      const r = verifyPermitV4(token, pubKeyB64, { checkExpiry });
      const c = r.claims;
      console.log(
        `PASS  permit_id=${c.permit_id}  action_type=${c.action_type}  actor_id=${c.actor_id}  environment=${c.environment}  exp=${c.exp}`,
      );
      return 0;
    } catch (err) {
      if (err instanceof VerifyError) {
        console.log(`FAIL  ${err.message}`);
        return 1;
      }
      throw err;
    }
  }

  // Evidence bundle mode: node verify.mjs [bundle.json] [trust-root.json]
  const bundlePath = args[0] ?? resolve(HERE, "bundle.json");
  const keysetPath = args[1] ?? resolve(HERE, "trust-root.json");

  let bundle, keySet;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
    keySet = JSON.parse(readFileSync(keysetPath, "utf8"));
  } catch (err) {
    console.error(`error: cannot read input: ${err.message}`);
    return 2;
  }

  try {
    const r = verifyEvidenceBundle(bundle, keySet);
    console.log(
      `PASS  bundle_id=${r.bundle_id}  key_id=${r.key_id}  records=${r.record_count}  checks=${r.checks.join(",")}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof VerifyError) {
      console.log(`FAIL  ${err.message}`);
      return 1;
    }
    throw err;
  }
}

process.exit(main());
