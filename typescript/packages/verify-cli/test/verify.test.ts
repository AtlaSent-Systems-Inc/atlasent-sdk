import { describe, it, expect } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  verifyEvidenceBundle,
  VerifyError,
  canonicalJson,
  recordEntryHash,
  merkleRootHex,
} from "../src/index.js"; // import through index to exercise re-exports
import type { EvidenceBundle, EvidenceRecord, KeySet } from "../src/index.js";
import { main } from "../src/cli.js";

// ── test keypair (one per suite run) ─────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const rawPub = publicKey.export({ type: "spki", format: "der" }).slice(-32);
const KEY_ID = "test-key-verify-2026";
const KEY_SET: KeySet = {
  issuing_keys: [
    {
      key_id: KEY_ID,
      alg: "Ed25519",
      public_key_b64: rawPub.toString("base64"),
    },
  ],
};

// ── fixture builders ──────────────────────────────────────────────────────────

function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

/** Canonical JSON (mirror of src/verify.ts — independent impl for tests). */
function cj(v: unknown): string {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return "[" + (v as unknown[]).map(cj).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${cj(o[k])}`).join(",") + "}";
  }
  throw new Error(`uncanonicalizable: ${typeof v}`);
}

function buildRecord(
  content: Record<string, unknown>,
  prevHash: string,
): EvidenceRecord {
  const payload = { ...content, prev_hash: prevHash };
  const forHash: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k !== "entry_hash" && k !== "signature") forHash[k] = v;
  }
  const entryHash = sha256hex(
    Buffer.concat([Buffer.from(prevHash, "hex"), Buffer.from(cj(forHash), "utf8")]),
  );
  return { ...payload, entry_hash: entryHash };
}

function merkle(leafHexes: string[]): string {
  if (leafHexes.length === 0) return sha256hex(Buffer.alloc(0));
  let level = leafHexes.map((h) =>
    sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(h, "hex")])),
  );
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha256(Buffer.concat([Buffer.from([0x01]), level[i]!, level[i + 1]!])));
      } else {
        next.push(level[i]!);
      }
    }
    level = next;
  }
  return level[0]!.toString("hex");
}

function signBundle(
  records: EvidenceRecord[],
  bundleId?: string,
  overrideSummary?: string,
): EvidenceBundle {
  const genesis = sha256hex(Buffer.alloc(0));
  const chain = {
    first_prev_hash: genesis,
    first_entry_hash: records[0]!.entry_hash,
    last_entry_hash: records[records.length - 1]!.entry_hash,
    entry_count: records.length,
  };
  const summaryHash = overrideSummary ?? merkle(records.map((r) => r.entry_hash));
  const unsigned: Record<string, unknown> = {
    ...(bundleId !== undefined ? { bundle_id: bundleId } : {}),
    records,
    chain_context: chain,
    summary_hash: summaryHash,
  };
  const digest = sha256(Buffer.from(cj(unsigned), "utf8"));
  const sigBuf = edSign(null, digest, privateKey);
  return {
    ...(unsigned as Omit<EvidenceBundle, "signature">),
    signature: { alg: "Ed25519", key_id: KEY_ID, signature_b64: sigBuf.toString("base64") },
  };
}

function makeBundle(n = 2, bundleId = "bundle-test"): EvidenceBundle {
  const genesis = sha256hex(Buffer.alloc(0));
  const records: EvidenceRecord[] = [];
  let prev = genesis;
  for (let i = 0; i < n; i++) {
    const rec = buildRecord({ action_type: "production.deploy", seq: i, decision: "allow" }, prev);
    records.push(rec);
    prev = rec.entry_hash;
  }
  return signBundle(records, bundleId);
}

// ── canonicalJson unit tests ──────────────────────────────────────────────────

describe("canonicalJson", () => {
  it("serializes primitives", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson("hello")).toBe('"hello"');
    expect(canonicalJson(42)).toBe("42");
  });

  it("sorts object keys", () => {
    expect(canonicalJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it("handles nested objects and arrays", () => {
    expect(canonicalJson({ b: [3, 1], a: { z: null } })).toBe('{"a":{"z":null},"b":[3,1]}');
  });

  it("throws on floats", () => {
    expect(() => canonicalJson(1.5)).toThrow(VerifyError);
  });

  it("throws on unsupported types", () => {
    expect(() => canonicalJson(undefined)).toThrow(VerifyError);
  });
});

// ── merkleRootHex unit tests ──────────────────────────────────────────────────

describe("merkleRootHex", () => {
  const leaf = (s: string) => sha256hex(Buffer.from(s, "utf8"));

  it("empty input", () => {
    expect(merkleRootHex([])).toBe(sha256hex(Buffer.alloc(0)));
  });

  it("one leaf — returned as-is (no hash)", () => {
    const l = leaf("a");
    const result = merkleRootHex([l]);
    expect(result).toBe(sha256hex(Buffer.concat([Buffer.from([0x00]), Buffer.from(l, "hex")])));
  });

  it("even number of leaves", () => {
    const a = leaf("a");
    const b = leaf("b");
    const aHash = sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(a, "hex")]));
    const bHash = sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(b, "hex")]));
    const root = sha256hex(Buffer.concat([Buffer.from([0x01]), aHash, bHash]));
    expect(merkleRootHex([a, b])).toBe(root);
  });

  it("odd number of leaves — last promoted unchanged", () => {
    const [a, b, c] = ["a", "b", "c"].map(leaf);
    expect(merkleRootHex([a!, b!, c!])).not.toBe(merkleRootHex([a!, b!]));
  });
});

// ── recordEntryHash unit test ─────────────────────────────────────────────────

describe("recordEntryHash", () => {
  it("matches the test fixture builder", () => {
    const genesis = sha256hex(Buffer.alloc(0));
    const rec = buildRecord({ action_type: "test", decision: "allow" }, genesis);
    expect(recordEntryHash(rec)).toBe(rec.entry_hash);
  });

  it("strips entry_hash and signature fields before hashing", () => {
    const genesis = sha256hex(Buffer.alloc(0));
    const rec = buildRecord({ action_type: "test" }, genesis);
    const withExtra = { ...rec, signature: "ignored" };
    expect(recordEntryHash(withExtra as EvidenceRecord)).toBe(rec.entry_hash);
  });
});

// ── verifyEvidenceBundle — happy path ─────────────────────────────────────────

describe("verifyEvidenceBundle — happy path", () => {
  it("1 record", () => {
    const b = makeBundle(1, "b1");
    const r = verifyEvidenceBundle(b, KEY_SET);
    expect(r.ok).toBe(true);
    expect(r.bundle_id).toBe("b1");
    expect(r.key_id).toBe(KEY_ID);
    expect(r.record_count).toBe(1);
    expect(r.checks).toEqual(["signature", "chain_binding", "summary_hash"]);
  });

  it("2 records (even Merkle)", () => {
    const r = verifyEvidenceBundle(makeBundle(2), KEY_SET);
    expect(r.ok).toBe(true);
    expect(r.record_count).toBe(2);
  });

  it("3 records (odd Merkle — last promoted)", () => {
    const r = verifyEvidenceBundle(makeBundle(3), KEY_SET);
    expect(r.ok).toBe(true);
    expect(r.record_count).toBe(3);
  });

  it("4 records (balanced Merkle tree)", () => {
    const r = verifyEvidenceBundle(makeBundle(4), KEY_SET);
    expect(r.ok).toBe(true);
    expect(r.record_count).toBe(4);
  });

  it("bundle without bundle_id", () => {
    const genesis = sha256hex(Buffer.alloc(0));
    const rec = buildRecord({ x: 1 }, genesis);
    const b = signBundle([rec]); // no bundleId arg
    const r = verifyEvidenceBundle(b, KEY_SET);
    expect(r.bundle_id).toBeUndefined();
  });
});

// ── verifyEvidenceBundle — signature failures ─────────────────────────────────

describe("verifyEvidenceBundle — signature failures", () => {
  it("tampered signature_b64", () => {
    const b = makeBundle();
    const bad = { ...b, signature: { ...b.signature, signature_b64: "AAAA" + b.signature.signature_b64.slice(4) } };
    expect(() => verifyEvidenceBundle(bad, KEY_SET)).toThrow("signature_invalid");
  });

  it("unknown key_id", () => {
    const b = makeBundle();
    const bad = { ...b, signature: { ...b.signature, key_id: "unknown-key" } };
    expect(() => verifyEvidenceBundle(bad, KEY_SET)).toThrow("unknown_key_id");
  });

  it("unsupported key alg", () => {
    const altSet: KeySet = {
      issuing_keys: [{ key_id: KEY_ID, alg: "RSA", public_key_b64: "x" }],
    };
    const b = makeBundle();
    expect(() => verifyEvidenceBundle(b, altSet)).toThrow("unsupported key alg");
  });

  it("missing signature.key_id", () => {
    const b = makeBundle();
    const { key_id: _k, ...sigWithout } = b.signature;
    const bad = { ...b, signature: sigWithout as typeof b.signature };
    expect(() => verifyEvidenceBundle(bad, KEY_SET)).toThrow("missing signature.key_id");
  });

  it("missing signature.signature_b64", () => {
    const b = makeBundle();
    const { signature_b64: _s, ...sigWithout } = b.signature;
    const bad = { ...b, signature: sigWithout as typeof b.signature };
    expect(() => verifyEvidenceBundle(bad, KEY_SET)).toThrow("missing signature.signature_b64");
  });

  it("unsupported signature alg", () => {
    const b = makeBundle();
    const bad = { ...b, signature: { ...b.signature, alg: "HMAC-SHA256" } };
    expect(() => verifyEvidenceBundle(bad, KEY_SET)).toThrow("unsupported signature alg");
  });
});

// ── verifyEvidenceBundle — chain failures ─────────────────────────────────────

describe("verifyEvidenceBundle — chain failures", () => {
  it("tampered record content → entry_hash mismatch", () => {
    const b = makeBundle(2);
    const records = [...b.records];
    records[0] = { ...records[0]!, decision: "deny" }; // tamper content, keep old entry_hash
    const bad = signBundle(records as EvidenceRecord[], "tampered", b.summary_hash);
    // Use the real signature of the tampered bundle
    expect(() => verifyEvidenceBundle(bad, KEY_SET)).toThrow("entry_hash does not match");
  });

  it("broken prev_hash link", () => {
    const genesis = sha256hex(Buffer.alloc(0));
    const r0 = buildRecord({ seq: 0 }, genesis);
    const r1_bad = { ...buildRecord({ seq: 1 }, genesis), prev_hash: "deadbeef".repeat(8) };
    // rebuild entry_hash for r1 with the broken prev_hash so chain is internally consistent
    const r1: EvidenceRecord = {
      ...r1_bad,
      entry_hash: recordEntryHash(r1_bad),
    };
    const b = signBundle([r0, r1], "chain-break");
    expect(() => verifyEvidenceBundle(b, KEY_SET)).toThrow("prev_hash does not link");
  });

  it("entry_count mismatch", () => {
    const b = makeBundle(2);
    const bad = { ...b, chain_context: { ...b.chain_context, entry_count: 99 } };
    const signingInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bad)) if (k !== "signature") signingInput[k] = v;
    const digest = sha256(Buffer.from(cj(signingInput), "utf8"));
    const sigBuf = edSign(null, digest, privateKey);
    const resigned = { ...bad, signature: { ...bad.signature, signature_b64: sigBuf.toString("base64") } };
    expect(() => verifyEvidenceBundle(resigned, KEY_SET)).toThrow("entry_count");
  });

  it("first_entry_hash mismatch", () => {
    const b = makeBundle(2);
    const bad = { ...b, chain_context: { ...b.chain_context, first_entry_hash: "aa".repeat(32) } };
    const signingInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bad)) if (k !== "signature") signingInput[k] = v;
    const digest = sha256(Buffer.from(cj(signingInput), "utf8"));
    const sigBuf = edSign(null, digest, privateKey);
    const resigned = { ...bad, signature: { ...bad.signature, signature_b64: sigBuf.toString("base64") } };
    expect(() => verifyEvidenceBundle(resigned, KEY_SET)).toThrow("first_entry_hash mismatch");
  });

  it("last_entry_hash mismatch", () => {
    const b = makeBundle(2);
    const bad = { ...b, chain_context: { ...b.chain_context, last_entry_hash: "bb".repeat(32) } };
    const signingInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bad)) if (k !== "signature") signingInput[k] = v;
    const digest = sha256(Buffer.from(cj(signingInput), "utf8"));
    const sigBuf = edSign(null, digest, privateKey);
    const resigned = { ...bad, signature: { ...bad.signature, signature_b64: sigBuf.toString("base64") } };
    expect(() => verifyEvidenceBundle(resigned, KEY_SET)).toThrow("last_entry_hash mismatch");
  });

  it("no records", () => {
    const b = makeBundle(1);
    const bad = { ...b, records: [] };
    const signingInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bad)) if (k !== "signature") signingInput[k] = v;
    const digest = sha256(Buffer.from(cj(signingInput), "utf8"));
    const sigBuf = edSign(null, digest, privateKey);
    const resigned = { ...bad, signature: { ...bad.signature, signature_b64: sigBuf.toString("base64") } };
    expect(() => verifyEvidenceBundle(resigned, KEY_SET)).toThrow("no records");
  });
});

// ── verifyEvidenceBundle — Merkle failures ────────────────────────────────────

describe("verifyEvidenceBundle — Merkle failures", () => {
  it("tampered summary_hash", () => {
    const b = makeBundle(2);
    const bad = { ...b, summary_hash: "cc".repeat(32) };
    const signingInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bad)) if (k !== "signature") signingInput[k] = v;
    const digest = sha256(Buffer.from(cj(signingInput), "utf8"));
    const sigBuf = edSign(null, digest, privateKey);
    const resigned = { ...bad, signature: { ...bad.signature, signature_b64: sigBuf.toString("base64") } };
    expect(() => verifyEvidenceBundle(resigned, KEY_SET)).toThrow("summary_hash_mismatch");
  });
});

// ── verifyEvidenceBundle — missing field failures ─────────────────────────────

describe("verifyEvidenceBundle — missing required fields", () => {
  it("not an object", () => {
    expect(() => verifyEvidenceBundle(null as unknown as EvidenceBundle, KEY_SET)).toThrow("bundle is not an object");
  });

  for (const field of ["records", "chain_context", "summary_hash", "signature"] as const) {
    it(`missing ${field}`, () => {
      const b = makeBundle();
      const bad = { ...b };
      delete (bad as Record<string, unknown>)[field];
      expect(() => verifyEvidenceBundle(bad as EvidenceBundle, KEY_SET)).toThrow(`missing field: ${field}`);
    });
  }

  it("signature not an object", () => {
    const b = makeBundle();
    const bad = { ...b, signature: "not-an-object" };
    expect(() => verifyEvidenceBundle(bad as unknown as EvidenceBundle, KEY_SET)).toThrow("signature is not an object");
  });
});

// ── CLI unit tests ────────────────────────────────────────────────────────────

const TMPDIR = join(tmpdir(), "atlasent-verify-test");
mkdirSync(TMPDIR, { recursive: true });

function writeTempBundle(name: string, bundle: EvidenceBundle, ks: KeySet): [string, string] {
  const bp = join(TMPDIR, `${name}-bundle.json`);
  const kp = join(TMPDIR, `${name}-keyset.json`);
  writeFileSync(bp, JSON.stringify(bundle));
  writeFileSync(kp, JSON.stringify(ks));
  return [bp, kp];
}

describe("cli main()", () => {
  it("--help returns 0", () => {
    expect(main(["--help"])).toBe(0);
  });

  it("-h returns 0", () => {
    expect(main(["-h"])).toBe(0);
  });

  it("missing file returns 2", () => {
    expect(main(["/nonexistent/bundle.json", "/nonexistent/trust-root.json"])).toBe(2);
  });

  it("missing file with --json returns 2", () => {
    expect(main(["--json", "/nonexistent/bundle.json", "/nonexistent/trust-root.json"])).toBe(2);
  });

  it("valid bundle returns 0 (text output)", () => {
    const [bp, kp] = writeTempBundle("pass", makeBundle(2, "cli-pass"), KEY_SET);
    expect(main([bp, kp])).toBe(0);
  });

  it("valid bundle returns 0 (--json output)", () => {
    const [bp, kp] = writeTempBundle("pass-json", makeBundle(2, "cli-pass-json"), KEY_SET);
    expect(main(["--json", bp, kp])).toBe(0);
  });

  it("invalid bundle (bad sig) returns 1 (text output)", () => {
    const b = makeBundle(1);
    const bad = { ...b, signature: { ...b.signature, signature_b64: "AAAA" } };
    const [bp, kp] = writeTempBundle("fail-text", bad, KEY_SET);
    expect(main([bp, kp])).toBe(1);
  });

  it("invalid bundle returns 1 (--json output)", () => {
    const b = makeBundle(1);
    const bad = { ...b, signature: { ...b.signature, signature_b64: "AAAA" } };
    const [bp, kp] = writeTempBundle("fail-json", bad, KEY_SET);
    expect(main(["--json", bp, kp])).toBe(1);
  });
});
