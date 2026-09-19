/**
 * What `protect()` actually puts on the wire for the execution-payload
 * binding.
 *
 * `test/payload-hash-parity.test.ts` proves the digest FUNCTIONS agree across
 * repos. That is necessary and was never sufficient: the defect that shipped
 * was `protect()` computing a correct digest and then presenting it in a form
 * `v1-verify-permit` cannot match. So these tests assert the posted request
 * BODIES, never the arguments handed to a client method — an argument-level
 * assertion cannot see which field a value lands in, or whether it reaches the
 * wire at all, and both of those were wrong here:
 *
 *   - `execution_hash` at verify was bare hex against a `sha256:`-prefixed
 *     bound value. Deterministic `PAYLOAD_MISMATCH`, every call.
 *   - `executionPayloadHash` — which the AI tool-guard wrappers compute with
 *     binding on by DEFAULT — was dropped twice over: `ProtectRequest`
 *     declared three fields, and `client.evaluate` builds an allowlisted body.
 *     It never reached the runtime, so `execution_hash_expected` was never
 *     bound from a caller digest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { AtlaSentError, configure, protect } from "../src/index.js";
import { __resetSharedClientForTests } from "../src/protect.js";
import { canonicalizePayload } from "../src/payloadHash.js";

const EVALUATE_ALLOW_WIRE = {
  permitted: true,
  decision_id: "dec_bind",
  reason: "allowed",
  audit_hash: "hash_bind",
  timestamp: "2026-09-19T10:00:00Z",
};

const VERIFY_OK_WIRE = {
  verified: true,
  outcome: "verified",
  permit_hash: "permit_bind",
  timestamp: "2026-09-19T10:00:01Z",
};

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Records every posted body. Deliberately captures the raw JSON text and
 * re-parses it, so a value that cannot survive serialization (a `undefined`,
 * a class instance) is seen here exactly as the server would see it.
 */
function recordingFetch(captured: Captured[], responses: unknown[]) {
  const queue = [...responses];
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    captured.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    const next = queue.shift();
    if (next === undefined) throw new Error("mock fetch queue exhausted");
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/**
 * The server's binding, recomputed from the body THIS TEST saw posted — not
 * from a body the test reconstructs independently. That is the point: it pins
 * the mirror to the real request, so adding a field to the evaluate body
 * without mirroring it fails here instead of in production.
 *
 * Mirrors `v1-evaluate`: strip `traceparent` / `shadow` / `explain`, then
 * `hashPayload` (which prefixes the scheme).
 */
function serverBoundHashOf(evaluateBody: Record<string, unknown>): string {
  const { traceparent: _t, shadow: _s, explain: _e, ...core } = evaluateBody;
  return (
    "sha256:" + createHash("sha256").update(canonicalizePayload(core), "utf8").digest("hex")
  );
}

const HEX_A = "a1b2c3d4".repeat(8);

describe("protect(): execution-payload binding on the wire", () => {
  const ORIGINAL_ENV = process.env.ATLASENT_API_KEY;

  beforeEach(() => {
    __resetSharedClientForTests();
    delete process.env.ATLASENT_API_KEY;
  });

  afterEach(() => {
    __resetSharedClientForTests();
    if (ORIGINAL_ENV !== undefined) process.env.ATLASENT_API_KEY = ORIGINAL_ENV;
    else delete process.env.ATLASENT_API_KEY;
  });

  describe("no caller digest — the server-fallback binding", () => {
    it("presents a digest that MATCHES the hash the server bound", async () => {
      // THE regression test. Before the fix this presented bare hex against a
      // `sha256:`-prefixed bound value, so verify denied every call with
      // PAYLOAD_MISMATCH while both repos' suites stayed green.
      const captured: Captured[] = [];
      configure({
        apiKey: "ask_live_test",
        fetch: recordingFetch(captured, [EVALUATE_ALLOW_WIRE, VERIFY_OK_WIRE]),
      });

      await protect({
        agent: "agent-7",
        action: "tools.write_file",
        context: { environment: "production", input: { path: "/tmp/x", body: "hello" } },
      });

      expect(captured).toHaveLength(2);
      const [evaluate, verify] = captured as [Captured, Captured];
      expect(evaluate.url).toContain("/v1-evaluate");
      expect(verify.url).toContain("/v1-verify-permit");

      expect(verify.body["execution_hash"]).toBe(serverBoundHashOf(evaluate.body));
    });

    it("presents it in the prefixed form, not bare hex", async () => {
      const captured: Captured[] = [];
      configure({
        apiKey: "ask_live_test",
        fetch: recordingFetch(captured, [EVALUATE_ALLOW_WIRE, VERIFY_OK_WIRE]),
      });

      await protect({ agent: "a", action: "t.x", context: { environment: "production" } });

      const presented = captured[1]?.body["execution_hash"];
      expect(typeof presented).toBe("string");
      expect(presented as string).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("does not send execution_payload_hash when the caller supplied none", async () => {
      // Additive-by-default: a caller that binds nothing must post a body
      // byte-identical to before this feature existed, or the server's own
      // fallback hash changes and every such permit breaks.
      const captured: Captured[] = [];
      configure({
        apiKey: "ask_live_test",
        fetch: recordingFetch(captured, [EVALUATE_ALLOW_WIRE, VERIFY_OK_WIRE]),
      });

      await protect({ agent: "a", action: "t.x", context: { environment: "production" } });

      expect(captured[0]?.body).not.toHaveProperty("execution_payload_hash");
      expect(Object.keys(captured[0]?.body ?? {}).sort()).toEqual([
        "action_type",
        "actor_id",
        "context",
      ]);
    });
  });

  describe("hashes the body it actually posted, not a reconstruction", () => {
    it("still matches when the request carries a field beyond the core three", async () => {
      // The mirror-drift regression, in the direction that already bit the
      // Python SDK: its hand-written three-key mirror omitted
      // `state_snapshot`, so every protect(state_snapshot=...) call was a
      // guaranteed PAYLOAD_MISMATCH independently of the prefix defect.
      // `protect()` now hashes buildEvaluateBody() output from the same input
      // client.evaluate() gets, so any field that reaches the wire is covered.
      const captured: Captured[] = [];
      configure({
        apiKey: "ask_live_test",
        fetch: recordingFetch(captured, [EVALUATE_ALLOW_WIRE, VERIFY_OK_WIRE]),
      });

      // Reaches the wire through the same path a JS caller uses when passing a
      // field the ProtectRequest type does not declare.
      await protect({
        agent: "a",
        action: "t.x",
        context: { environment: "production" },
        state_snapshot: { source: "terraform", payload: { replicas: 3 } },
      } as Parameters<typeof protect>[0]);

      const [evaluate, verify] = captured as [Captured, Captured];
      expect(
        evaluate.body,
        "precondition: the extra field must reach the wire, or this proves nothing",
      ).toHaveProperty("state_snapshot");
      expect(verify.body["execution_hash"]).toBe(serverBoundHashOf(evaluate.body));
    });

    it("strips the fields the server strips before hashing (`explain`)", async () => {
      // Found by mutation testing: removing the traceparent/shadow/explain
      // strip survived the whole suite, because nothing sent one. `explain` is
      // a declared evaluate field that reaches the wire and that `v1-evaluate`
      // removes from the body before computing its own hash, so including it
      // here would be a deterministic PAYLOAD_MISMATCH for every
      // `protect({ ..., explain: true })` caller.
      const captured: Captured[] = [];
      configure({
        apiKey: "ask_live_test",
        fetch: recordingFetch(captured, [EVALUATE_ALLOW_WIRE, VERIFY_OK_WIRE]),
      });

      await protect({
        agent: "a",
        action: "t.x",
        context: { environment: "production" },
        explain: true,
      } as Parameters<typeof protect>[0]);

      const [evaluate, verify] = captured as [Captured, Captured];
      expect(
        evaluate.body,
        "precondition: explain must reach the wire, or this proves nothing",
      ).toHaveProperty("explain", true);
      // serverBoundHashOf strips it, exactly as v1-evaluate does.
      expect(verify.body["execution_hash"]).toBe(serverBoundHashOf(evaluate.body));
    });

    it("`explain` does NOT change the presented digest, since the server drops it", async () => {
      // The other half: stripping must not be so eager that it also drops a
      // field the server keeps, and must actually make the two requests agree.
      const captured: Captured[] = [];
      configure({
        apiKey: "ask_live_test",
        fetch: recordingFetch(captured, [
          EVALUATE_ALLOW_WIRE,
          VERIFY_OK_WIRE,
          EVALUATE_ALLOW_WIRE,
          VERIFY_OK_WIRE,
        ]),
      });

      const base = { agent: "a", action: "t.x", context: { environment: "production" } };
      await protect(base);
      await protect({ ...base, explain: true } as Parameters<typeof protect>[0]);

      expect(captured[1]?.body["execution_hash"]).toBe(
        captured[3]?.body["execution_hash"],
      );
    });

    it("the extra field changes the presented digest", async () => {
      // If it did not, the hash would not be covering it and the assertion
      // above could pass for the wrong reason.
      const captured: Captured[] = [];
      configure({
        apiKey: "ask_live_test",
        fetch: recordingFetch(captured, [
          EVALUATE_ALLOW_WIRE,
          VERIFY_OK_WIRE,
          EVALUATE_ALLOW_WIRE,
          VERIFY_OK_WIRE,
        ]),
      });

      const base = { agent: "a", action: "t.x", context: { environment: "production" } };
      await protect(base);
      await protect({
        ...base,
        state_snapshot: { source: "terraform", payload: { replicas: 3 } },
      } as Parameters<typeof protect>[0]);

      expect(captured[1]?.body["execution_hash"]).not.toBe(
        captured[3]?.body["execution_hash"],
      );
    });
  });

  describe("caller digest supplied — the binding that constrains execution", () => {
    it("sends it TOP-LEVEL as execution_payload_hash, bare hex", async () => {
      // Both properties are load-bearing and each was wrong in a shipped
      // client: nested under `context` is never a binding, and a prefixed
      // value fails the runtime's bare-hex regex and is dropped silently.
      const captured: Captured[] = [];
      configure({
        apiKey: "ask_live_test",
        fetch: recordingFetch(captured, [EVALUATE_ALLOW_WIRE, VERIFY_OK_WIRE]),
      });

      await protect({
        agent: "agent-7",
        action: "tools.write_file",
        context: { environment: "production" },
        executionPayloadHash: HEX_A,
      });

      const evaluateBody = captured[0]?.body ?? {};
      expect(evaluateBody["execution_payload_hash"]).toBe(HEX_A);
      expect(
        (evaluateBody["context"] as Record<string, unknown>),
        "a digest inside context is never a binding",
      ).not.toHaveProperty("execution_payload_hash");
    });

    it("presents the CALLER digest at verify, not the server mirror", async () => {
      // With a caller digest bound, `execution_hash_expected` IS that bare
      // hex — so presenting the prefixed whole-body mirror would now be the
      // mismatch. The presented form has to follow which binding is in force.
      const captured: Captured[] = [];
      configure({
        apiKey: "ask_live_test",
        fetch: recordingFetch(captured, [EVALUATE_ALLOW_WIRE, VERIFY_OK_WIRE]),
      });

      await protect({
        agent: "a",
        action: "t.x",
        context: { environment: "production" },
        executionPayloadHash: HEX_A,
      });

      const verifyBody = captured[1]?.body ?? {};
      expect(verifyBody["execution_hash"]).toBe(HEX_A);
      expect(verifyBody["execution_hash"]).not.toMatch(/^sha256:/);
      expect(verifyBody["execution_hash"]).not.toBe(serverBoundHashOf(captured[0]?.body ?? {}));
    });

    it("normalizes a sha256:-prefixed digest instead of letting it be dropped", async () => {
      const captured: Captured[] = [];
      configure({
        apiKey: "ask_live_test",
        fetch: recordingFetch(captured, [EVALUATE_ALLOW_WIRE, VERIFY_OK_WIRE]),
      });

      await protect({
        agent: "a",
        action: "t.x",
        context: { environment: "production" },
        executionPayloadHash: `sha256:${HEX_A.toUpperCase()}`,
      });

      expect(captured[0]?.body["execution_payload_hash"]).toBe(HEX_A);
      expect(captured[1]?.body["execution_hash"]).toBe(HEX_A);
    });

    it("the digest actually depends on what was hashed", async () => {
      // A correctly-shaped but constant binding is worse than none: it reads
      // as bound in every audit row while authorizing any payload.
      const captured: Captured[] = [];
      configure({
        apiKey: "ask_live_test",
        fetch: recordingFetch(captured, [
          EVALUATE_ALLOW_WIRE,
          VERIFY_OK_WIRE,
          EVALUATE_ALLOW_WIRE,
          VERIFY_OK_WIRE,
        ]),
      });

      const digestOf = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

      await protect({
        agent: "a",
        action: "t.x",
        context: { environment: "production" },
        executionPayloadHash: digestOf("alpha"),
      });
      await protect({
        agent: "a",
        action: "t.x",
        context: { environment: "production" },
        executionPayloadHash: digestOf("omega"),
      });

      expect(captured[0]?.body["execution_payload_hash"]).not.toBe(
        captured[2]?.body["execution_payload_hash"],
      );
    });

    it("THROWS before any network call on a malformed digest", async () => {
      // Fail closed at the client boundary. Forwarding it would mint a permit
      // bound to the server's own request hash instead, which the caller has
      // no way to distinguish from a real binding.
      const captured: Captured[] = [];
      configure({
        apiKey: "ask_live_test",
        fetch: recordingFetch(captured, [EVALUATE_ALLOW_WIRE, VERIFY_OK_WIRE]),
      });

      await expect(
        protect({
          agent: "a",
          action: "t.x",
          context: { environment: "production" },
          executionPayloadHash: "not-a-digest",
        }),
      ).rejects.toThrow(AtlaSentError);

      expect(captured, "a rejected digest must not reach the runtime").toHaveLength(0);
    });
  });
});
