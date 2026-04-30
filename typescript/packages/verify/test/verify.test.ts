/**
 * @atlasent/verify — library API tests against shared contract fixtures.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { canonicalJSON, signedBytesFor, verifyAuditBundle, verifyBundle, type AuditBundle } from "../src/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = resolve(HERE, "../../../../contract/vectors/audit-bundles");
const PUBLIC_PEM = readFileSync(resolve(FIXTURES, "signing-key.pub.pem"), "utf8");

function bundlePath(name: string): string {
  return resolve(FIXTURES, name);
}

function loadBundle(name: string): AuditBundle {
  const raw = JSON.parse(readFileSync(bundlePath(name), "utf8")) as Record<string, unknown>;
  return (raw["bundle"] ?? raw) as AuditBundle;
}

// ─── canonicalJSON ────────────────────────────────────────────────────────────

describe("canonicalJSON", () => {
  it("sorts object keys at every depth", () => {
    expect(canonicalJSON({ b: 1, a: { z: 2, y: 3 } })).toBe('{"a":{"y":3,"z":2},"b":1}');
  });

  it("normalises null, undefined, NaN, ±Infinity to null", () => {
    expect(canonicalJSON(null)).toBe("null");
    expect(canonicalJSON(undefined)).toBe("null");
    expect(canonicalJSON(Number.NaN)).toBe("null");
    expect(canonicalJSON(Number.POSITIVE_INFINITY)).toBe("null");
  });

  it("preserves array order", () => {
    expect(canonicalJSON([3, 1, 2])).toBe("[3,1,2]");
  });

  it("uses standard JSON string escapes", () => {
    expect(canonicalJSON('hello "world"\n')).toBe('"hello \\"world\\"\\n"');
  });
});

// ─── verifyBundle against contract fixtures ───────────────────────────────────

describe("verifyBundle against shared contract fixtures", () => {
  it("valid bundle → every check passes", async () => {
    const r = await verifyBundle(bundlePath("valid.json"), { publicKeysPem: [PUBLIC_PEM] });
    expect(r.verified).toBe(true);
    expect(r.chainIntegrityOk).toBe(true);
    expect(r.signatureValid).toBe(true);
    expect(r.headHashMatches).toBe(true);
    expect(r.tamperedEventIds).toEqual([]);
    expect(r.matchedKeyId).toBe("pem_0");
  });

  it("tampered-event bundle → chain integrity fails", async () => {
    const r = await verifyBundle(bundlePath("tampered-event.json"), { publicKeysPem: [PUBLIC_PEM] });
    expect(r.verified).toBe(false);
    expect(r.chainIntegrityOk).toBe(false);
    expect(r.tamperedEventIds.length).toBeGreaterThan(0);
  });

  it("broken-chain bundle → adjacency fail", async () => {
    const r = await verifyBundle(bundlePath("broken-chain.json"), { publicKeysPem: [PUBLIC_PEM] });
    expect(r.verified).toBe(false);
    expect(r.chainIntegrityOk).toBe(false);
  });

  it("bad-signature bundle → signature invalid", async () => {
    const r = await verifyBundle(bundlePath("bad-signature.json"), { publicKeysPem: [PUBLIC_PEM] });
    expect(r.verified).toBe(false);
    expect(r.signatureValid).toBe(false);
    expect(r.reason).toContain("did not verify");
  });

  it("wrong-key bundle → signature invalid with correct reason", async () => {
    const r = await verifyBundle(bundlePath("wrong-key.json"), { publicKeysPem: [PUBLIC_PEM] });
    expect(r.verified).toBe(false);
    expect(r.signatureValid).toBe(false);
  });

  it("accepts an already-parsed AuditBundle object", async () => {
    const bundle = loadBundle("valid.json");
    const r = await verifyBundle(bundle, { publicKeysPem: [PUBLIC_PEM] });
    expect(r.verified).toBe(true);
  });

  it("no keys → signatureValid false, chain still checked", async () => {
    const r = await verifyBundle(bundlePath("valid.json"), {});
    expect(r.signatureValid).toBe(false);
    expect(r.chainIntegrityOk).toBe(true);
    expect(r.reason).toContain("no signing keys");
  });

  it("malformed PEM skipped, valid PEM accepted", async () => {
    const r = await verifyBundle(bundlePath("valid.json"), {
      publicKeysPem: ["NOT_A_PEM", PUBLIC_PEM],
    });
    expect(r.verified).toBe(true);
    expect(r.matchedKeyId).toBe("pem_1");
  });
});

// ─── verifyAuditBundle directly ───────────────────────────────────────────────

describe("verifyAuditBundle", () => {
  it("empty events → chain integrity ok (vacuously), no tampered ids", async () => {
    const bundle: AuditBundle = {
      export_id: "x",
      org_id: "o",
      chain_head_hash: "0".repeat(64),
      event_count: 0,
      signed_at: "2026-01-01T00:00:00Z",
      events: [],
      signature: "",
    };
    const r = await verifyAuditBundle(bundle, []);
    expect(r.tamperedEventIds).toEqual([]);
    expect(r.signatureValid).toBe(false);
    expect(r.reason).toContain("no signing keys");
  });

  it("bundle with no signature string → signatureValid false", async () => {
    const bundle = loadBundle("valid.json");
    const r = await verifyAuditBundle({ ...bundle, signature: "" }, []);
    expect(r.signatureValid).toBe(false);
    expect(r.reason).toContain("no signing keys");
  });
});

// ─── signedBytesFor ───────────────────────────────────────────────────────────

describe("signedBytesFor", () => {
  it("includes the six envelope fields in insertion order", () => {
    const bundle: AuditBundle = {
      export_id: "e1",
      org_id: "o1",
      chain_head_hash: "h1",
      event_count: 1,
      signed_at: "2026-01-01T00:00:00Z",
      events: [],
      extra_ignored: "yes",
    };
    const bytes = signedBytesFor(bundle);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["export_id", "org_id", "chain_head_hash", "event_count", "signed_at", "events"]);
    expect(parsed["extra_ignored"]).toBeUndefined();
  });
});
