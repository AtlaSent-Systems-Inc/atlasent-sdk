/**
 * Offline verifier for pt.v4.* COSE Sign1 permit tokens (ADR-050).
 *
 * pt.v4.{base64url(COSE_Sign1_bytes)} where COSE_Sign1_bytes is a CBOR-encoded
 * COSE_Sign1 structure (RFC 9052, CBOR tag 18):
 *   #6.18([bstr(protected_header), {}, bstr(permit_claims_cbor), bstr(sig)])
 *
 * The bytes signed by Ed25519 are the COSE Sig_Structure (RFC 9052 §4.4):
 *   ["Signature1", bstr(protected_header), bstr(""), bstr(permit_claims_cbor)]
 *
 * Protected header: { 1: -8 } = 0xa1 0x01 0x27 (COSE algorithm EdDSA, RFC 8037).
 * Permit claims: CBOR integer-keyed map (keys 4/6/7/–1..–7, see PermitClaimsV4).
 *
 * Offline by design: with a pinned Ed25519 public key this function needs no
 * network. It is the SDK mirror of the atlasent-api `_shared/cose.ts` decode path.
 *
 * Uses the Web Crypto API (`crypto.subtle`) — available in browsers, Node ≥18,
 * Deno, and Bun. No external dependencies.
 */

export type PermitV4VerifyReason =
  | 'bad_format'
  | 'bad_prefix'
  | 'cose_decode_failed'
  | 'wrong_protected_header'
  | 'claims_decode_failed'
  | 'signature_invalid'
  | 'expired';

export class PermitV4VerifyError extends Error {
  readonly reason: PermitV4VerifyReason;
  constructor(reason: PermitV4VerifyReason, message: string) {
    super(`${reason}: ${message}`);
    this.name = 'PermitV4VerifyError';
    this.reason = reason;
  }
}

export interface PermitClaimsV4 {
  permit_id: string;    // UUID (from key 7 / CWT cti — 16-byte bstr)
  exp: number;          // Unix epoch seconds (key 4)
  iat: number;          // Unix epoch seconds (key 6)
  decision_id: string;  // tstr (key -1)
  org_id: string;       // UUID (key -2 — 16-byte bstr)
  action_type: string;  // tstr (key -3)
  actor_id: string;     // tstr (key -4)
  environment: string;  // "live" | "test" (key -5)
  cdo_hash?: string;    // 64-char hex sha256 (key -6, optional)
  policy_hash?: string; // 64-char hex sha256 (key -7, optional)
}

export interface PermitV4VerifyResult {
  ok: true;
  claims: PermitClaimsV4;
}

// ─── CBOR primitives ──────────────────────────────────────────────────────────

class CborReader {
  private pos = 0;
  constructor(private readonly b: Uint8Array) {}

  private readByte(): number {
    if (this.pos >= this.b.length) throw new Error('cbor: unexpected end');
    return this.b[this.pos++]!;
  }

  private readUintVal(add: number): number {
    if (add <= 23) return add;
    if (add === 24) return this.readByte();
    if (add === 25) return (this.readByte() << 8) | this.readByte();
    if (add === 26) {
      return ((this.readByte() << 24) >>> 0 | (this.readByte() << 16) | (this.readByte() << 8) | this.readByte());
    }
    throw new Error('cbor: unsupported additional value ' + add);
  }

  private readHead(): { major: number; n: number } {
    const b = this.readByte();
    return { major: (b >> 5) & 7, n: this.readUintVal(b & 0x1f) };
  }

  readBstr(): Uint8Array {
    const { major, n } = this.readHead();
    if (major !== 2) throw new Error('cbor: expected bstr, got major ' + major);
    const out = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  readArrayLen(): number {
    const { major, n } = this.readHead();
    if (major !== 4) throw new Error('cbor: expected array, got major ' + major);
    return n;
  }

  readMapLen(): number {
    const { major, n } = this.readHead();
    if (major !== 5) throw new Error('cbor: expected map, got major ' + major);
    return n;
  }

  readInt(): number {
    const { major, n } = this.readHead();
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    throw new Error('cbor: expected int, got major ' + major);
  }

  readTstr(): string {
    const { major, n } = this.readHead();
    if (major !== 3) throw new Error('cbor: expected tstr, got major ' + major);
    const bytes = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return new TextDecoder().decode(bytes);
  }

  skip(): void {
    const { major, n } = this.readHead();
    if (major <= 1) return;
    if (major === 2 || major === 3) { this.pos += n; return; }
    if (major === 4) { for (let i = 0; i < n; i++) this.skip(); return; }
    if (major === 5) { for (let i = 0; i < n * 2; i++) this.skip(); return; }
    if (major === 6) { this.skip(); return; }
    throw new Error('cbor: unsupported major ' + major);
  }

  peekMajor(): number { return (this.b[this.pos]! >> 5) & 7; }

  readTagNum(): number {
    const { major, n } = this.readHead();
    if (major !== 6) throw new Error('cbor: expected tag, got major ' + major);
    return n;
  }
}

// ─── Base64url helpers ────────────────────────────────────────────────────────

function fromB64url(s: string): Uint8Array {
  // Pad to multiple of 4 and convert url-safe chars.
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((s.length + 3) % 4 === 0 ? 2 : (s.length + 3) % 4 === 1 ? 0 : (s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesHex(b: Uint8Array): string {
  let out = '';
  for (const byte of b) out += byte.toString(16).padStart(2, '0');
  return out;
}

function uuidFromBytes(b: Uint8Array): string {
  return [
    bytesHex(b.slice(0, 4)),
    bytesHex(b.slice(4, 6)),
    bytesHex(b.slice(6, 8)),
    bytesHex(b.slice(8, 10)),
    bytesHex(b.slice(10, 16)),
  ].join('-');
}

// ─── COSE Sign1 decode ────────────────────────────────────────────────────────

const PROTECTED_HEADER_BYTES = Uint8Array.of(0xa1, 0x01, 0x27);

function decodeCoseSign1(bytes: Uint8Array): {
  protectedBytes: Uint8Array;
  payloadBytes: Uint8Array;
  sig: Uint8Array;
} {
  const r = new CborReader(bytes);
  if (r.peekMajor() === 6) r.readTagNum(); // optional tag 18
  const len = r.readArrayLen();
  if (len !== 4) throw new Error('cose: expected 4-element array, got ' + len);
  const protectedBytes = r.readBstr();
  r.skip(); // unprotected map {}
  const payloadBytes = r.readBstr();
  const sig = r.readBstr();
  return { protectedBytes, payloadBytes, sig };
}

function buildSigStructure(protectedBytes: Uint8Array, payloadBytes: Uint8Array): Uint8Array {
  // Sig_Structure = ["Signature1", bstr(protected), bstr(""), bstr(payload)]
  // CBOR encode inline: array(4) + tstr("Signature1") + bstr(protected) + bstr("") + bstr(payload)
  const enc = new TextEncoder();
  const context = enc.encode('Signature1');
  const empty = new Uint8Array(0);

  function cborUint(n: number): Uint8Array {
    if (n <= 23) return Uint8Array.of(n);
    if (n <= 0xff) return Uint8Array.of(24, n);
    if (n <= 0xffff) return Uint8Array.of(25, n >> 8, n & 0xff);
    return Uint8Array.of(26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }

  function cborBstr(b: Uint8Array): Uint8Array {
    const head = cborUint(b.length);
    head[0]! |= 0x40;
    return concat([head, b]);
  }

  function cborTstr(s: Uint8Array): Uint8Array {
    const head = cborUint(s.length);
    head[0]! |= 0x60;
    return concat([head, s]);
  }

  const arrayHead = Uint8Array.of(0x84); // array(4)
  return concat([
    arrayHead,
    cborTstr(context),
    cborBstr(protectedBytes),
    cborBstr(empty),
    cborBstr(payloadBytes),
  ]);
}

function concat(arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// ─── Permit claims decode ─────────────────────────────────────────────────────

function decodePermitClaims(bytes: Uint8Array): PermitClaimsV4 {
  const r = new CborReader(bytes);
  const len = r.readMapLen();
  const result: Partial<PermitClaimsV4> = {};
  for (let i = 0; i < len; i++) {
    const key = r.readInt();
    switch (key) {
      case 4:  result.exp = r.readInt(); break;
      case 6:  result.iat = r.readInt(); break;
      case 7:  result.permit_id = uuidFromBytes(r.readBstr()); break;
      case -1: result.decision_id = r.readTstr(); break;
      case -2: result.org_id = uuidFromBytes(r.readBstr()); break;
      case -3: result.action_type = r.readTstr(); break;
      case -4: result.actor_id = r.readTstr(); break;
      case -5: result.environment = r.readTstr(); break;
      case -6: result.cdo_hash = bytesHex(r.readBstr()); break;
      case -7: result.policy_hash = bytesHex(r.readBstr()); break;
      default: r.skip();
    }
  }
  const required = ['exp', 'iat', 'permit_id', 'decision_id', 'org_id', 'action_type', 'actor_id', 'environment'] as const;
  for (const f of required) {
    if (result[f] === undefined) throw new Error(`missing required claim: ${f}`);
  }
  return result as PermitClaimsV4;
}

// ─── Main API ─────────────────────────────────────────────────────────────────

/**
 * Verify a pt.v4.* COSE Sign1 permit token offline.
 *
 * Decodes the base64url payload, verifies the EdDSA signature against the
 * supplied Ed25519 public key (raw 32 bytes, standard base64), and returns
 * the decoded permit claims.
 *
 * Does NOT verify `exp` — pass `checkExpiry: true` to enable that check.
 * The permit may still be revoked server-side even when this returns `ok: true`.
 *
 * @param token       - Full pt.v4.* token string
 * @param publicKeyB64 - Raw 32-byte Ed25519 public key, standard base64
 * @param opts.checkExpiry - If true, throws if claims.exp ≤ now (default false)
 */
export async function verifyPermitV4(
  token: string,
  publicKeyB64: string,
  opts?: { checkExpiry?: boolean },
): Promise<PermitV4VerifyResult> {
  if (typeof token !== 'string') {
    throw new PermitV4VerifyError('bad_format', 'token must be a string');
  }
  if (!token.startsWith('pt.v4.')) {
    throw new PermitV4VerifyError('bad_prefix', `expected pt.v4.* prefix, got: ${token.slice(0, 12)}`);
  }

  const b64Payload = token.slice('pt.v4.'.length);
  let coseBytes: Uint8Array;
  try {
    coseBytes = fromB64url(b64Payload);
  } catch {
    throw new PermitV4VerifyError('bad_format', 'base64url decode failed');
  }

  let protectedBytes: Uint8Array, payloadBytes: Uint8Array, sig: Uint8Array;
  try {
    ({ protectedBytes, payloadBytes, sig } = decodeCoseSign1(coseBytes));
  } catch (e) {
    throw new PermitV4VerifyError('cose_decode_failed', (e as Error).message);
  }

  // Verify the protected header is exactly { 1: -8 } = 0xa1 0x01 0x27.
  if (
    protectedBytes.length !== PROTECTED_HEADER_BYTES.length ||
    protectedBytes[0] !== PROTECTED_HEADER_BYTES[0] ||
    protectedBytes[1] !== PROTECTED_HEADER_BYTES[1] ||
    protectedBytes[2] !== PROTECTED_HEADER_BYTES[2]
  ) {
    throw new PermitV4VerifyError('wrong_protected_header', 'expected EdDSA protected header { 1: -8 }');
  }

  let claims: PermitClaimsV4;
  try {
    claims = decodePermitClaims(payloadBytes);
  } catch (e) {
    throw new PermitV4VerifyError('claims_decode_failed', (e as Error).message);
  }

  // Build Sig_Structure and verify Ed25519 signature.
  const toVerify = buildSigStructure(protectedBytes, payloadBytes);
  const rawKey = fromB64(publicKeyB64);
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'raw',
      rawKey as unknown as ArrayBuffer,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
  } catch {
    throw new PermitV4VerifyError('signature_invalid', 'invalid Ed25519 public key');
  }

  const ok = await crypto.subtle.verify(
    { name: 'Ed25519' },
    cryptoKey,
    sig as unknown as ArrayBuffer,
    toVerify as unknown as ArrayBuffer,
  );
  if (!ok) {
    throw new PermitV4VerifyError('signature_invalid', 'Ed25519 signature did not verify');
  }

  if (opts?.checkExpiry) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (claims.exp <= nowSec) {
      throw new PermitV4VerifyError('expired', `permit expired at ${new Date(claims.exp * 1000).toISOString()}`);
    }
  }

  return { ok: true, claims };
}
