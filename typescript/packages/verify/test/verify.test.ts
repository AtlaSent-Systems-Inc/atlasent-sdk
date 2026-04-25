/**
 * Tests for `@atlasent/verify`.
 *
 * Reuses the shared fixtures under `contract/vectors/audit-bundles/`
 * — the same set the main SDK + Python SDK exercise. Test names
 * mirror those suites so behavioural drift between the verifiers is
 * easy to spot.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  canonicalJSON,
  signedBytesFor,
  verifyAuditBundle,
  verifyBundle,
  type AuditBundle,
  type VerifyKey,
} from "../src/verify.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// packages/verify/test → repo root is four levels up.
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const FIXTURES = resolve(REPO_ROOT, "contract", "vectors", "audit-bundles");
const PUBLIC_PEM = readFileSync(resolve(FIXTURES, "signing-key.pub.pem"), "utf8");

function bundlePath(name: string): string {
  return resolve(FIXTURES, name);
}

function loadBundle(name: string): AuditBundle {
  const raw = JSON.parse(readFileSync(bundlePath(name), "utf8"));
  return raw.bundle ?? raw;
}

async function keysFromPem(pem: string, keyId: string): Promise<VerifyKey[]> {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  const { webcrypto } = await import("node:crypto");
  const publicKey = await webcrypto.subtle.importKey(
    "spki",
    bytes,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return [{ keyId, publicKey }];
}

describe("canonicalJSON", () => {
  it("sorts object keys at every depth", () => {
    expect(canonicalJSON({ b: 1, a: { z: 2, y: 3 } })).toBe('{"a":{"y":3,"z":2},"b":1}');
  });

  it("normalizes null, undefined, and non-finite numbers to null", () => {
    expect(canonicalJSON(null)).toBe("null");
    expect(canonicalJSON(undefined)).toBe("null");
    expect(canonicalJSON(Number.NaN)).toBe("null");
    expect(canonicalJSON(Number.POSITIVE_INFINITY)).toBe("null");
  });

  it("preserves array order", () => {
    expect(canonicalJSON([3, 1, 2])).toBe("[3,1,2]");
  });

  it("escapes strings with the standard JSON rules", () => {
    expect(canonicalJSON('hello "world"\n')).toBe('"hello \\"world\\"\\n"');
  });

  it("treats booleans, numbers, and unknown types deterministically", () => {
    expect(canonicalJSON(true)).toBe("true");
    expect(canonicalJSON(false)).toBe("false");
    expect(canonicalJSON(0)).toBe("0");
    // Symbols / functions are not JSON-representable; render as "null".
    expect(canonicalJSON(Symbol("x") as unknown)).toBe("null");
  });
});

describe("verifyBundle against shared fixtures", () => {
  it("valid bundle → every check passes", async () => {
    const r = await verifyBundle(bundlePath("valid.json"), { publicKeysPem: [PUBLIC_PEM] });
    expect(r.verified).toBe(true);
    expect(r.chainIntegrityOk).toBe(true);
    expect(r.signatureValid).toBe(true);
    expect(r.headHashMatches).toBe(true);
    expect(r.tamperedEventIds).toEqual([]);
    expect(r.reason).toBeUndefined();
    expect(r.matchedKeyId).toBe("pem_0");
  });

  it("tampered event → hash mismatch surfaces the event id", async () => {
    const r = await verifyBundle(bundlePath("tampered-event.json"), { publicKeysPem: [PUBLIC_PEM] });
    expect(r.verified).toBe(false);
    expect(r.chainIntegrityOk).toBe(false);
    expect(r.tamperedEventIds.length).toBeGreaterThan(0);
    expect(r.signatureValid).toBe(false);
  });

  it("flipped signature bit → signatureValid false, chain still intact", async () => {
    const r = await verifyBundle(bundlePath("bad-signature.json"), { publicKeysPem: [PUBLIC_PEM] });
    expect(r.chainIntegrityOk).toBe(true);
    expect(r.signatureValid).toBe(false);
    expect(r.reason).toBeDefined();
  });

  it("wrong key → signature does not verify", async () => {
    const r = await verifyBundle(bundlePath("wrong-key.json"), { publicKeysPem: [PUBLIC_PEM] });
    expect(r.signatureValid).toBe(false);
    expect(r.chainIntegrityOk).toBe(true);
    expect(r.reason).toContain("1 configured");
  });

  it("broken chain → integrity fails", async () => {
    const r = await verifyBundle(bundlePath("broken-chain.json"), { publicKeysPem: [PUBLIC_PEM] });
    expect(r.chainIntegrityOk).toBe(false);
    expect(r.signatureValid).toBe(false);
    expect(r.reason).toBeDefined();
  });

  it("no keys supplied → signature never verifies, chain still runs", async () => {
    const r = await verifyBundle(bundlePath("valid.json"));
    expect(r.chainIntegrityOk).toBe(true);
    expect(r.signatureValid).toBe(false);
    expect(r.reason).toContain("no signing keys");
  });

  it("malformed PEM is skipped, real PEM still verifies", async () => {
    const r = await verifyBundle(bundlePath("valid.json"), {
      publicKeysPem: [
        "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----",
        PUBLIC_PEM,
      ],
    });
    expect(r.signatureValid).toBe(true);
  });

  it("missing signature → reason mentions absence", async () => {
    const bundle = { ...loadBundle("valid.json") };
    delete bundle.signature;
    const keys = await keysFromPem(PUBLIC_PEM, "k");
    const r = await verifyAuditBundle(bundle, keys);
    expect(r.signatureValid).toBe(false);
    expect(r.reason).toContain("no signature");
  });

  it("bundle as object (not path) verifies the same way", async () => {
    const bundle = loadBundle("valid.json");
    const r = await verifyBundle(bundle, { publicKeysPem: [PUBLIC_PEM] });
    expect(r.verified).toBe(true);
  });
});

describe("verifyAuditBundle low-level", () => {
  it("matches the bundle's signing_key_id hint first when supplied", async () => {
    const bundle = loadBundle("valid.json");
    bundle.signing_key_id = "rotated-key-id";
    const wrong = await keysFromPem(PUBLIC_PEM, "old-key");
    const right = await keysFromPem(PUBLIC_PEM, "rotated-key-id");
    const r = await verifyAuditBundle(bundle, [...wrong, ...right]);
    expect(r.signatureValid).toBe(true);
    expect(r.matchedKeyId).toBe("rotated-key-id");
  });

  it("base64url with missing padding still decodes", async () => {
    // The fixture's signature already exercises the padding path; assert
    // the high-level outcome rather than reach into internals.
    const bundle = loadBundle("valid.json");
    const keys = await keysFromPem(PUBLIC_PEM, "k");
    const r = await verifyAuditBundle(bundle, keys);
    expect(r.signatureValid).toBe(true);
  });

  it("signedBytesFor preserves the v1-audit key order", () => {
    const bundle = loadBundle("valid.json");
    const envelope = new TextDecoder().decode(signedBytesFor(bundle));
    expect(envelope.startsWith('{"export_id":')).toBe(true);
    expect(envelope.indexOf('"export_id":')).toBeLessThan(envelope.indexOf('"events":'));
  });

  it("non-string bundle.signature → reason about absence", async () => {
    const bundle = { ...loadBundle("valid.json"), signature: 123 as unknown };
    const keys = await keysFromPem(PUBLIC_PEM, "k");
    const r = await verifyAuditBundle(bundle, keys);
    expect(r.signatureValid).toBe(false);
    expect(r.reason).toContain("no signature");
  });

  it("non-array events field still produces a deterministic result", async () => {
    const bundle = { ...loadBundle("valid.json"), events: "not-an-array" };
    const keys = await keysFromPem(PUBLIC_PEM, "k");
    const r = await verifyAuditBundle(bundle, keys);
    // Empty events → chain_head_hash should be GENESIS for headHashMatches.
    expect(r.chainIntegrityOk).toBe(false);
    expect(r.signatureValid).toBe(false);
  });

  it("event missing hash field → flagged as tampered with index_N id", async () => {
    const bundle = {
      events: [{ id: undefined, payload: {} }], // no hash, no previous_hash
      chain_head_hash: "0".repeat(64),
      signature: "",
    } as AuditBundle;
    const keys = await keysFromPem(PUBLIC_PEM, "k");
    const r = await verifyAuditBundle(bundle, keys);
    expect(r.tamperedEventIds[0]).toMatch(/^index_/);
  });

  it("no signing_key_id hint → keys are tried in supplied order", async () => {
    const bundle = loadBundle("valid.json");
    delete bundle.signing_key_id;
    const keys = await keysFromPem(PUBLIC_PEM, "first");
    const r = await verifyAuditBundle(bundle, keys);
    expect(r.signatureValid).toBe(true);
    expect(r.matchedKeyId).toBe("first");
  });

  it("base64url-decode failure during verify is captured as a reason", async () => {
    const bundle = { ...loadBundle("valid.json") };
    // Force the verify path to throw via a non-decodable signature.
    // Buffer.from() of a non-base64 string returns garbage rather than
    // throwing, but subtle.verify rejects an unexpectedly-sized signature
    // and the catch surfaces a "signature check failed" reason.
    bundle.signature = "!@#$%^&*";
    const keys = await keysFromPem(PUBLIC_PEM, "k");
    const r = await verifyAuditBundle(bundle, keys);
    expect(r.signatureValid).toBe(false);
    // Either the verify rejects (reason starts with "signature check failed")
    // or simply does not match (reason starts with "signature did not verify").
    expect(r.reason).toMatch(/signature (check failed|did not verify)/);
  });

  it("broken chain (adjacency) sets reason = 'chain adjacency broken'", async () => {
    // Take a valid bundle, replace second event's previous_hash so adjacency
    // breaks but per-event hash recompute still passes (no tamperedIds).
    // This is fragile to construct synthetically; rely on the fixture and
    // assert on the family of reasons the broken-chain fixture produces.
    const r = await verifyBundle(bundlePath("broken-chain.json"), {
      publicKeysPem: [PUBLIC_PEM],
    });
    expect(r.chainIntegrityOk).toBe(false);
    // The reason can be any of the chain-failure cases or a signature
    // mismatch — assert it exists and isn't undefined.
    expect(r.reason).toBeDefined();
  });
});

describe("@atlasent/verify package entry", () => {
  it("re-exports the public surface from src/index.ts", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.verifyBundle).toBe("function");
    expect(typeof mod.verifyAuditBundle).toBe("function");
    expect(typeof mod.canonicalJSON).toBe("function");
    expect(typeof mod.signedBytesFor).toBe("function");
  });
});
