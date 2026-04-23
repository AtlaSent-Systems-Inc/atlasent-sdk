import { sign, generateKeyPairSync } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import { verifyBundle } from "../src/audit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical JSON matching Python's json.dumps(sort_keys=True). */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonicalize((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

function makeKeyPair() {
  return generateKeyPairSync("ed25519");
}

function signBundle(
  events: unknown[],
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): string {
  const canonical = canonicalize(events);
  return sign(null, Buffer.from(canonical, "utf-8"), privateKey).toString("hex");
}

function pubKeyHex(keyPair: ReturnType<typeof generateKeyPairSync>): string {
  // Ed25519 SPKI DER = 12-byte header + 32-byte raw key
  const der = keyPair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return der.slice(-32).toString("hex");
}

async function writeTmp(obj: unknown): Promise<string> {
  const path = join(tmpdir(), `atlasent-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(path, JSON.stringify(obj), "utf-8");
  tmpFiles.push(path);
  return path;
}

const tmpFiles: string[] = [];

afterEach(async () => {
  for (const f of tmpFiles.splice(0)) {
    await unlink(f).catch(() => {});
  }
});

const EVENTS = [
  {
    actor_id: "agent-1",
    action: "modify_patient_record",
    audit_hash: "h_001",
    decision_id: "dec_001",
    event_id: "evt_001",
    permitted: true,
    timestamp: "2026-01-15T12:00:00Z",
  },
  {
    actor_id: "agent-2",
    action: "read_phi",
    audit_hash: "h_002",
    decision_id: "dec_002",
    event_id: "evt_002",
    permitted: true,
    timestamp: "2026-01-15T12:01:00Z",
  },
];

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe("verifyBundle — valid bundles", () => {
  it("returns valid=true for a correctly signed bundle", async () => {
    const kp = makeKeyPair();
    const pub = pubKeyHex(kp);
    const sig = signBundle(EVENTS, kp.privateKey);

    const path = await writeTmp({ version: "1", events: EVENTS, public_key: pub, signature: sig });
    const result = await verifyBundle(path);

    expect(result.valid).toBe(true);
    expect(result.eventCount).toBe(2);
    expect(result.publicKey).toBe(pub);
    expect(result.error).toBe("");
  });

  it("returns valid=true for a single-event bundle", async () => {
    const kp = makeKeyPair();
    const pub = pubKeyHex(kp);
    const events = [EVENTS[0]];
    const sig = signBundle(events, kp.privateKey);

    const path = await writeTmp({ version: "1", events, public_key: pub, signature: sig });
    const result = await verifyBundle(path);

    expect(result.valid).toBe(true);
    expect(result.eventCount).toBe(1);
  });

  it("returns valid=true for an empty events list", async () => {
    const kp = makeKeyPair();
    const pub = pubKeyHex(kp);
    const sig = signBundle([], kp.privateKey);

    const path = await writeTmp({ version: "1", events: [], public_key: pub, signature: sig });
    const result = await verifyBundle(path);

    expect(result.valid).toBe(true);
    expect(result.eventCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tampered bundle tests
// ---------------------------------------------------------------------------

describe("verifyBundle — tampered bundles", () => {
  it("returns valid=false when an event field is mutated", async () => {
    const kp = makeKeyPair();
    const pub = pubKeyHex(kp);
    const sig = signBundle(EVENTS, kp.privateKey);

    const tampered = structuredClone(EVENTS);
    tampered[0].permitted = false; // mutate after signing

    const path = await writeTmp({ version: "1", events: tampered, public_key: pub, signature: sig });
    const result = await verifyBundle(path);

    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns valid=false for a wrong signature (all zeros)", async () => {
    const kp = makeKeyPair();
    const pub = pubKeyHex(kp);

    const path = await writeTmp({
      version: "1",
      events: EVENTS,
      public_key: pub,
      signature: "00".repeat(64),
    });
    const result = await verifyBundle(path);

    expect(result.valid).toBe(false);
  });

  it("returns valid=false when public key doesn't match signing key", async () => {
    const kp1 = makeKeyPair();
    const kp2 = makeKeyPair();
    const sig = signBundle(EVENTS, kp1.privateKey);
    const wrongPub = pubKeyHex(kp2); // different key

    const path = await writeTmp({
      version: "1",
      events: EVENTS,
      public_key: wrongPub,
      signature: sig,
    });
    const result = await verifyBundle(path);

    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("verifyBundle — error cases", () => {
  it("throws when file does not exist", async () => {
    await expect(verifyBundle("/nonexistent/path/bundle.json")).rejects.toThrow(
      /Cannot read audit bundle/,
    );
  });

  it("throws when file is not valid JSON", async () => {
    const path = join(tmpdir(), `atlasent-bad-${Date.now()}.json`);
    await writeFile(path, "not json {{{", "utf-8");
    tmpFiles.push(path);
    await expect(verifyBundle(path)).rejects.toThrow(/not valid JSON/);
  });

  it("throws when events field is missing", async () => {
    const path = await writeTmp({ public_key: "aa".repeat(32), signature: "bb".repeat(64) });
    await expect(verifyBundle(path)).rejects.toThrow(/missing required field.*events/);
  });

  it("throws when public_key field is missing", async () => {
    const path = await writeTmp({ events: [], signature: "bb".repeat(64) });
    await expect(verifyBundle(path)).rejects.toThrow(/missing required field.*public_key/);
  });

  it("throws when signature field is missing", async () => {
    const path = await writeTmp({ events: [], public_key: "aa".repeat(32) });
    await expect(verifyBundle(path)).rejects.toThrow(/missing required field.*signature/);
  });

  it("returns valid=false for invalid public_key hex", async () => {
    const path = await writeTmp({
      events: EVENTS,
      public_key: "not-hex",
      signature: "aa".repeat(64),
    });
    const result = await verifyBundle(path);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/hex/i);
  });

  it("returns valid=false for invalid signature hex", async () => {
    const kp = makeKeyPair();
    const pub = pubKeyHex(kp);
    const path = await writeTmp({ events: EVENTS, public_key: pub, signature: "not-hex" });
    const result = await verifyBundle(path);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/hex/i);
  });
});
