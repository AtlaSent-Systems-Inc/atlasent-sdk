/**
 * Cross-repo parity gate for the execution-payload digest.
 *
 * WHY THIS FILE EXISTS. `protect()` presents a digest at verify that
 * `v1-verify-permit` compares against whatever the permit was bound to at
 * evaluate time, folding case and normalizing nothing else. For the whole life
 * of that code the SDK returned BARE hex while the server's `hashPayload`
 * returns `"sha256:" + hex`, so the two could never compare equal: a
 * deterministic `PAYLOAD_MISMATCH` on every `protect()` call against a runtime
 * that populates the binding — which `v1-evaluate` does unconditionally.
 *
 * Nothing caught it. Both repos' suites were green. The SDK's own tests mock
 * `fetch`, so the server's digest never appeared in any assertion, and the
 * server's tests never saw the SDK's. Two implementations of one wire value,
 * each tested only against itself.
 *
 * So this file pins BOTH halves, and neither alone would be enough:
 *
 *   - A vendored reference copy of the server function, so a change to the
 *     SDK's canonicalization fails here rather than in a customer's audit.
 *   - Committed golden digests, so the vendored copy cannot be edited into
 *     agreement with a broken SDK. Editing both to match is then a visible,
 *     deliberate act in a diff, not a plausible accident.
 *
 * The goldens were generated from the real server source at
 * `atlasent-api/supabase/functions/_shared/canonical.ts` (`canonicalize` +
 * `hashPayload`). Regenerate them ONLY alongside a deliberate, reviewed
 * canonical-form change on both sides — a chain version bump, in the language
 * `atlasent-verify` uses for the same rule.
 *
 * Worth recording, because it shaped the fix: the digest MATERIAL was already
 * correct. All ten vectors below — unicode, escape sequences, `undefined` in
 * objects and in arrays, numerics including 1e21, empty containers, key
 * ordering — produce byte-identical hex on both sides. The scheme prefix alone
 * denied the permit.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  canonicalizePayload,
  isBarePayloadHash,
  serverPayloadHash,
} from "../src/payloadHash.js";
import { normalizeExecutionPayloadHash } from "../src/protect.js";
import { AtlaSentError } from "../src/index.js";

// ---------------------------------------------------------------------------
// Vendored REFERENCE implementation.
//
// Verbatim from atlasent-api supabase/functions/_shared/canonical.ts. This is
// deliberately a second copy and not an import: the server file is Deno source
// in another repository and is not resolvable from this package. Keep it
// byte-for-byte identical to the original, comments aside.
// ---------------------------------------------------------------------------
function referenceCanonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return (
      "[" +
      value
        .map((v) => (v === undefined ? "null" : referenceCanonicalize(v)))
        .join(",") +
      "]"
    );
  }
  const entries: string[] = [];
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    entries.push(JSON.stringify(k) + ":" + referenceCanonicalize(v));
  }
  return "{" + entries.join(",") + "}";
}

function referenceHashPayload(payload: unknown): string {
  return (
    "sha256:" +
    createHash("sha256").update(referenceCanonicalize(payload), "utf8").digest("hex")
  );
}

/**
 * The digest form the SDK produced BEFORE the fix: the same canonical bytes,
 * hashed the same way, emitted without the scheme prefix. Kept so the test can
 * state the defect precisely — the material agreed, the form did not — and so
 * a regression back to bare hex is caught by name.
 */
function preFixSdkHash(payload: unknown): string {
  const sortKeysDeep = (val: unknown): unknown => {
    if (Array.isArray(val)) return val.map(sortKeysDeep);
    if (val !== null && typeof val === "object") {
      return Object.keys(val as object)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sortKeysDeep((val as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return val;
  };
  return createHash("sha256")
    .update(JSON.stringify(sortKeysDeep(payload)), "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Vectors + committed goldens.
// ---------------------------------------------------------------------------
const VECTORS: Record<string, unknown> = {
  minimal: { action_type: "tools.search", actor_id: "agent-1", context: {} },
  nested: {
    action_type: "tools.write_file",
    actor_id: "agent-7",
    context: {
      environment: "production",
      input: { path: "/etc/x", body: "hello" },
      session: "s1",
    },
  },
  keyorder: { context: { b: 1, a: 2 }, actor_id: "a", action_type: "t" },
  unicode: {
    action_type: "tools.send",
    actor_id: "agent-é",
    context: { input: "café — naïve 🚀" },
  },
  arrays: { action_type: "t", actor_id: "a", context: { xs: [3, 1, { z: 1, y: 2 }, null] } },
  numerics: {
    action_type: "t",
    actor_id: "a",
    context: { i: 1, f: 1.5, neg: -0.25, big: 1e21, zero: 0 },
  },
  emptyish: {
    action_type: "t",
    actor_id: "a",
    context: { s: "", o: {}, arr: [], n: null, t: true },
  },
  undef_in_obj: { action_type: "t", actor_id: "a", context: { a: 1, b: undefined } },
  undef_in_arr: { action_type: "t", actor_id: "a", context: { xs: [1, undefined, 2] } },
  escapes: {
    action_type: "t",
    actor_id: "a",
    context: { s: 'line\nbreak\t"quote"\\slash' },
  },
};

/** Generated from the real server source. See this file's header. */
const GOLDEN_SERVER_HASH: Record<string, string> = {
  minimal: "sha256:8b873b92e37bacd9176d5c9e9074ba6dfc227b0cad3ceb5f6c3f9bd30e4e8c32",
  nested: "sha256:3a3ec3cfa7f4db281cdc331ded08a277aa9606a784652fc8853dfc7e422012ba",
  keyorder: "sha256:bc41c755b04990b48e2abd533eb49d0db57cf4cf8b427d35df67ad58c0868287",
  unicode: "sha256:3d539d6a1abe779bdbd1898a206b920775a77a3324c8532f68066b0bc39f20ed",
  arrays: "sha256:a84cec3c6bab38cace05ade5c3dc7e3f99a36110d8e02d646182f179dd62fe21",
  numerics: "sha256:2b89d8ec3e76e520457dda2bf23231c8e3d2dd3dc70520334bb6fc128a485d7b",
  emptyish: "sha256:cbdcfb3f3883c17ca155e4f236149d8e4697dc372e1930b3ba746d7dd6471055",
  undef_in_obj: "sha256:92ef636f112c10e3680c7d13441aaba32331309602dca49745a75a5c4b37e756",
  undef_in_arr: "sha256:e9306e2a94a333ad0d48a4545ff234174b03ebe7d41814a7e6bab2445653a3ae",
  escapes: "sha256:14c97bf5e53053c2c65c8be39fdb1cc255fe97769694fb756407eb813c54763e",
};

/** Canonical BYTES, not just the digest — a mismatch names the divergence. */
const GOLDEN_CANONICAL: Record<string, string> = {
  minimal: '{"action_type":"tools.search","actor_id":"agent-1","context":{}}',
  keyorder: '{"action_type":"t","actor_id":"a","context":{"a":2,"b":1}}',
  numerics:
    '{"action_type":"t","actor_id":"a","context":{"big":1e+21,"f":1.5,"i":1,"neg":-0.25,"zero":0}}',
  emptyish:
    '{"action_type":"t","actor_id":"a","context":{"arr":[],"n":null,"o":{},"s":"","t":true}}',
  // undefined is DROPPED from an object and becomes null in an array. Those
  // are different rules and both sides must apply both.
  undef_in_obj: '{"action_type":"t","actor_id":"a","context":{"a":1}}',
  undef_in_arr: '{"action_type":"t","actor_id":"a","context":{"xs":[1,null,2]}}',
  escapes:
    '{"action_type":"t","actor_id":"a","context":{"s":"line\\nbreak\\t\\"quote\\"\\\\slash"}}',
};

const VECTOR_NAMES = Object.keys(VECTORS);

describe("execution-payload digest: cross-repo parity", () => {
  it("covers every declared vector, so a shrinking suite is visible", () => {
    // A parity gate that silently stops covering a shape is the failure mode
    // that produced the defect. Assert the census.
    expect(VECTOR_NAMES.length).toBe(10);
    for (const name of VECTOR_NAMES) {
      expect(GOLDEN_SERVER_HASH, `no golden for vector "${name}"`).toHaveProperty(name);
    }
  });

  for (const name of VECTOR_NAMES) {
    describe(name, () => {
      const payload = VECTORS[name];

      it("SDK canonical bytes equal the vendored server reference", () => {
        expect(canonicalizePayload(payload)).toBe(referenceCanonicalize(payload));
      });

      it("SDK hash equals the vendored server reference", async () => {
        expect(await serverPayloadHash(payload)).toBe(referenceHashPayload(payload));
      });

      it("SDK hash equals the committed golden from the real server source", async () => {
        expect(await serverPayloadHash(payload)).toBe(GOLDEN_SERVER_HASH[name]);
      });

      if (GOLDEN_CANONICAL[name] !== undefined) {
        it("canonical bytes match the committed golden bytes", () => {
          expect(canonicalizePayload(payload)).toBe(GOLDEN_CANONICAL[name]);
        });
      }
    });
  }

  it('carries the "sha256:" scheme prefix — the regression that actually shipped', async () => {
    // Stated as its own assertion rather than left implicit in the goldens,
    // because this single missing prefix is what denied every protect() call.
    for (const name of VECTOR_NAMES) {
      const hash = await serverPayloadHash(VECTORS[name]);
      expect(hash.startsWith("sha256:"), `vector "${name}" lost its prefix`).toBe(true);
      expect(hash.slice("sha256:".length)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("differs from the pre-fix bare-hex form ONLY by that prefix", async () => {
    // The precise shape of the defect: correct material, wrong form. If these
    // ever differ by more than the prefix, the canonicalization itself has
    // drifted and the goldens above are the thing to trust.
    for (const name of VECTOR_NAMES) {
      const fixed = await serverPayloadHash(VECTORS[name]);
      expect(fixed).toBe(`sha256:${preFixSdkHash(VECTORS[name])}`);
      expect(fixed).not.toBe(preFixSdkHash(VECTORS[name]));
    }
  });

  it("distinguishes payloads that differ only past a truncation point", async () => {
    // A digest over a truncated preview cannot detect a change beyond the
    // cutoff, which is the whole reason the guard wrappers hash the full tool
    // input rather than the context preview.
    const prefix = "x".repeat(600);
    const a = { action_type: "t", actor_id: "a", context: { input: `${prefix}alpha` } };
    const b = { action_type: "t", actor_id: "a", context: { input: `${prefix}omega` } };
    expect(await serverPayloadHash(a)).not.toBe(await serverPayloadHash(b));
  });

  it("is order-independent over object keys but not over array elements", async () => {
    const k1 = { action_type: "t", actor_id: "a", context: { a: 1, b: 2 } };
    const k2 = { action_type: "t", actor_id: "a", context: { b: 2, a: 1 } };
    expect(await serverPayloadHash(k1)).toBe(await serverPayloadHash(k2));

    const a1 = { action_type: "t", actor_id: "a", context: { xs: [1, 2] } };
    const a2 = { action_type: "t", actor_id: "a", context: { xs: [2, 1] } };
    expect(await serverPayloadHash(a1)).not.toBe(await serverPayloadHash(a2));
  });
});

describe("normalizeExecutionPayloadHash (the single normalizer, from protect.ts)", () => {
  const HEX = "a".repeat(64);

  it("passes through bare lowercase hex", () => {
    expect(normalizeExecutionPayloadHash(HEX)).toBe(HEX);
  });

  it("lowercases, because v1-evaluate binds the lowercased value", () => {
    expect(normalizeExecutionPayloadHash("A".repeat(64))).toBe(HEX);
  });

  it('strips a "sha256:" prefix rather than letting the runtime drop the digest', () => {
    // The runtime's bare-hex regex rejects the prefixed form and then DROPS
    // it: allow, permit, 200, no error, no binding. Stripping here is what
    // makes the common OCI/sha256sum form usable instead of silently inert.
    expect(normalizeExecutionPayloadHash(`sha256:${HEX}`)).toBe(HEX);
    // Uppercase HEX is accepted and lowered; an uppercase PREFIX is not
    // stripped and throws instead. That is the real contract and it is
    // fail-closed: a shape it does not recognize is refused loudly rather than
    // forwarded for the runtime to drop silently.
    expect(normalizeExecutionPayloadHash(HEX.toUpperCase())).toBe(HEX);
    expect(() => normalizeExecutionPayloadHash(`SHA256:${HEX}`)).toThrow(AtlaSentError);
  });

  it("THROWS on anything else instead of forwarding a digest that will be dropped", () => {
    for (const bad of [
      "",
      "not-a-hash",
      "a".repeat(63),
      "a".repeat(65),
      `sha256:${"z".repeat(64)}`,
      "sha256:",
      HEX.slice(0, 32),
    ]) {
      expect(() => normalizeExecutionPayloadHash(bad), `accepted ${JSON.stringify(bad)}`).toThrow(
        AtlaSentError,
      );
    }
  });

  it("names the failure well enough to act on", () => {
    expect(() => normalizeExecutionPayloadHash("nope")).toThrow(/64 hex characters/);
  });
});

describe("isBarePayloadHash", () => {
  it("accepts exactly the form v1-evaluate will bind", () => {
    expect(isBarePayloadHash("a".repeat(64))).toBe(true);
    expect(isBarePayloadHash("A".repeat(64))).toBe(true);
  });

  it("rejects the prefixed form, which v1-evaluate drops", () => {
    expect(isBarePayloadHash(`sha256:${"a".repeat(64)}`)).toBe(false);
  });

  it("rejects non-strings and wrong lengths", () => {
    expect(isBarePayloadHash(undefined)).toBe(false);
    expect(isBarePayloadHash(null)).toBe(false);
    expect(isBarePayloadHash(123)).toBe(false);
    expect(isBarePayloadHash("a".repeat(63))).toBe(false);
  });
});
