import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyBundle } from "../src/index.js";
import { canonicalize, sha256Hex } from "../src/canonical.js";

function generateEd25519(): { priv: KeyObject; pub: KeyObject; pubPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString()
    .trim();
  return { priv: privateKey, pub: publicKey, pubPem };
}

function buildEnvelope(): {
  envelope: Record<string, unknown>;
  trustedPem: string;
  priv: KeyObject;
} {
  const { priv, pubPem } = generateEd25519();
  const org = "org-1";
  const row1Payload =
    `v2|${org}|ac-1|req-1|ci|allow||ctxh|pth|b-1|1|rh||` +
    `2026-04-16T10:00:00.000000Z|GENESIS`;
  const row1Hash = sha256Hex(row1Payload);
  const row2Payload =
    `v2|${org}|ac-1|req-2|ci|allow||ctxh|pth|b-1|1|rh||` +
    `2026-04-16T10:01:00.000000Z|${row1Hash}`;
  const row2Hash = sha256Hex(row2Payload);

  const envelope: Record<string, unknown> = {
    version: 1,
    org_id: org,
    generated_at: "2026-04-16T10:05:00.000Z",
    range: { since: null, until: null, limit: 10000 },
    evaluations: [
      {
        id: "e-1",
        canonical_payload: row1Payload,
        entry_hash: row1Hash,
        prev_hash: null,
      },
      {
        id: "e-2",
        canonical_payload: row2Payload,
        entry_hash: row2Hash,
        prev_hash: row1Hash,
      },
    ],
    execution_head: { id: "e-2", entry_hash: row2Hash },
    admin_log: [],
    admin_head: null,
    public_key_pem: pubPem,
  };
  const sig = nodeSign(null, Buffer.from(canonicalize(envelope), "utf8"), priv);
  envelope.signature = sig.toString("base64");
  return { envelope, trustedPem: pubPem, priv };
}

function reSign(envelope: Record<string, unknown>, priv: KeyObject): void {
  const envMinusSig: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) {
    if (k !== "signature") envMinusSig[k] = v;
  }
  const sig = nodeSign(null, Buffer.from(canonicalize(envMinusSig), "utf8"), priv);
  envelope.signature = sig.toString("base64");
}

describe("verifyBundle", () => {
  it("verifies a well-formed signed envelope with a trust anchor", async () => {
    const { envelope, trustedPem } = buildEnvelope();
    const result = await verifyBundle(envelope, {
      trustedPublicKeyPem: trustedPem,
    });
    expect(result.errors).toEqual([]);
    expect(result.chainOk).toBe(true);
    expect(result.signatureOk).toBe(true);
    expect(result.trustedKeyOk).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("self-verifies when no trust anchor is provided", async () => {
    const { envelope } = buildEnvelope();
    const result = await verifyBundle(envelope);
    expect(result.chainOk).toBe(true);
    expect(result.signatureOk).toBe(true);
    expect(result.trustedKeyOk).toBeNull();
    expect(result.ok).toBe(true);
  });

  it("detects a tampered canonical_payload", async () => {
    const { envelope, trustedPem } = buildEnvelope();
    const rows = envelope.evaluations as Array<Record<string, unknown>>;
    rows[0]!.canonical_payload = String(rows[0]!.canonical_payload).replace(
      "allow",
      "deny",
    );
    const result = await verifyBundle(envelope, {
      trustedPublicKeyPem: trustedPem,
    });
    expect(result.chainOk).toBe(false);
    expect(result.errors.some((e) => e.includes("sha256"))).toBe(true);
  });

  it("detects a broken prev-pointer chain", async () => {
    const { envelope, trustedPem, priv } = buildEnvelope();
    const rows = envelope.evaluations as Array<Record<string, unknown>>;
    envelope.evaluations = rows.reverse();
    reSign(envelope, priv);
    const result = await verifyBundle(envelope, {
      trustedPublicKeyPem: trustedPem,
    });
    expect(result.chainOk).toBe(false);
    expect(result.errors.some((e) => e.includes("prev"))).toBe(true);
  });

  it("detects a claimed head that does not match the chain tail", async () => {
    const { envelope, trustedPem, priv } = buildEnvelope();
    envelope.execution_head = { id: "e-bogus", entry_hash: "deadbeef" };
    reSign(envelope, priv);
    const result = await verifyBundle(envelope, {
      trustedPublicKeyPem: trustedPem,
    });
    expect(result.chainOk).toBe(false);
    expect(result.errors.some((e) => e.includes("claimed head"))).toBe(true);
  });

  it("detects a wrong trust anchor", async () => {
    const { envelope } = buildEnvelope();
    const other = generateEd25519();
    const result = await verifyBundle(envelope, {
      trustedPublicKeyPem: other.pubPem,
    });
    expect(result.signatureOk).toBe(true);
    expect(result.trustedKeyOk).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("trusted anchor"))).toBe(true);
  });

  it("detects a tampered signature", async () => {
    const { envelope, trustedPem } = buildEnvelope();
    const sig = Buffer.from(String(envelope.signature), "base64");
    sig[sig.length - 1]! ^= 0xff;
    envelope.signature = sig.toString("base64");
    const result = await verifyBundle(envelope, {
      trustedPublicKeyPem: trustedPem,
    });
    expect(result.signatureOk).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("returns errors when signature is missing", async () => {
    const { envelope } = buildEnvelope();
    delete envelope.signature;
    const result = await verifyBundle(envelope);
    expect(result.signatureOk).toBe(false);
    expect(result.errors.some((e) => e.includes("missing signature"))).toBe(true);
  });

  it("returns errors on a malformed PEM", async () => {
    const { envelope } = buildEnvelope();
    envelope.public_key_pem = "not a real key";
    const result = await verifyBundle(envelope);
    expect(result.signatureOk).toBe(false);
    expect(result.errors.some((e) => e.includes("public key"))).toBe(true);
  });

  it("verifies from a JSON file path", async () => {
    const { envelope, trustedPem } = buildEnvelope();
    const dir = await mkdtemp(join(tmpdir(), "atlasent-verify-"));
    const path = join(dir, "export.json");
    await writeFile(path, JSON.stringify(envelope), "utf8");
    const result = await verifyBundle(path, {
      trustedPublicKeyPem: trustedPem,
    });
    expect(result.ok).toBe(true);
  });

  it("ignores PEM whitespace when comparing against the trust anchor", async () => {
    const { envelope, trustedPem } = buildEnvelope();
    const mangled = trustedPem.replace(/\n/g, "\r\n") + "\n  ";
    const result = await verifyBundle(envelope, {
      trustedPublicKeyPem: mangled,
    });
    expect(result.trustedKeyOk).toBe(true);
  });

  it("allows empty chains", async () => {
    const { priv, pubPem } = generateEd25519();
    const envelope: Record<string, unknown> = {
      version: 1,
      org_id: "org-1",
      generated_at: "2026-04-16T10:00:00Z",
      range: { since: null, until: null, limit: 10000 },
      evaluations: [],
      execution_head: null,
      admin_log: [],
      admin_head: null,
      public_key_pem: pubPem,
    };
    reSign(envelope, priv);
    const result = await verifyBundle(envelope, {
      trustedPublicKeyPem: pubPem,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects non-object inputs", async () => {
    // @ts-expect-error — intentionally invalid for the runtime check
    await expect(verifyBundle(42)).rejects.toThrow(TypeError);
  });
});

describe("cross-SDK signature compatibility", () => {
  it("verifies an envelope produced against the same canonicalize", async () => {
    // A signed envelope built by the Python SDK's canonicalize should
    // byte-match the TS canonicalize — round-trip it through
    // `canonicalize` here and confirm nothing changes.
    const { envelope, trustedPem } = buildEnvelope();
    const { signature: _signature, ...envMinusSig } = envelope;
    const canonical1 = canonicalize(envMinusSig);
    // Parse → re-stringify → parse: must not drift.
    const roundTripped = JSON.parse(JSON.stringify(envMinusSig));
    const canonical2 = canonicalize(roundTripped);
    expect(canonical1).toBe(canonical2);

    // And the signature still verifies.
    const result = await verifyBundle(envelope, {
      trustedPublicKeyPem: trustedPem,
    });
    expect(result.ok).toBe(true);
  });
});

describe("canonicalize", () => {
  it("sorts object keys lexicographically", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("emits null for undefined", () => {
    expect(canonicalize(undefined)).toBe("null");
    expect(canonicalize([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("omits undefined object values", () => {
    expect(canonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it("passes through null values", () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  it("round-trips nested structures deterministically", () => {
    const a = canonicalize({ z: [1, { b: 2, a: 1 }], a: "x" });
    const b = canonicalize({ a: "x", z: [1, { a: 1, b: 2 }] });
    expect(a).toBe(b);
  });
});

it("createPublicKey recognises SPKI PEM (sanity)", () => {
  // Protect against environments where Ed25519 is unavailable — fail fast
  // with a clear error instead of a confusing verifier failure.
  const { pubPem } = generateEd25519();
  expect(() => createPublicKey(pubPem)).not.toThrow();
  // `createPrivateKey` should also round-trip.
  const { privateKey } = generateKeyPairSync("ed25519");
  expect(() =>
    createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" })),
  ).not.toThrow();
});
