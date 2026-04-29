import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";

import atlasent, {
  AtlaSentDeniedError,
  AtlaSentError,
  configure,
  withPermit,
  type Permit,
} from "../src/index.js";
import { __resetSharedClientForTests } from "../src/protect.js";

type FetchMock = MockedFunction<typeof fetch>;

const EVALUATE_ALLOW_WIRE = {
  permitted: true,
  decision_id: "dec_alpha",
  reason: "GxP policy authorized operator",
  audit_hash: "hash_alpha",
  timestamp: "2026-04-22T10:00:00Z",
};

const EVALUATE_DENY_WIRE = {
  permitted: false,
  decision_id: "dec_beta",
  reason: "Missing change_reason for critical field",
  audit_hash: "hash_beta",
  timestamp: "2026-04-22T10:01:00Z",
};

const VERIFY_OK_WIRE = {
  verified: true,
  outcome: "verified",
  permit_hash: "permit_alpha",
  timestamp: "2026-04-22T10:00:01Z",
};

const VERIFY_CONSUMED_WIRE = {
  verified: false,
  outcome: "permit_consumed",
  permit_hash: "permit_alpha",
  timestamp: "2026-04-22T10:00:02Z",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetchSequence(responses: Response[]): FetchMock {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("mock fetch queue exhausted");
    return next;
  }) as unknown as FetchMock;
}

describe("atlasent.withPermit", () => {
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

  it("is reachable as both named import and default-export method", () => {
    expect(typeof withPermit).toBe("function");
    expect(typeof atlasent.withPermit).toBe("function");
    expect(atlasent.withPermit).toBe(withPermit);
  });

  it("invokes fn with a verified permit and returns its result on ALLOW + verified", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const fn = vi.fn(async (permit: Permit) => {
      // The wrapped function sees a permit that has already been
      // verified (and therefore consumed by the v1 server).
      expect(permit.permitId).toBe("dec_alpha");
      expect(permit.permitHash).toBe("permit_alpha");
      return { ok: true, used: permit.permitId };
    });

    const result = await withPermit(
      { agent: "deploy-bot", action: "deploy_to_production" },
      fn,
    );

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, used: "dec_alpha" });
    // Two server round-trips: evaluate + verifyPermit. fn does not
    // hit the server in this test.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not invoke fn when policy returns DENY — fail-closed", async () => {
    const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const fn = vi.fn(async () => "should-not-run");

    await expect(
      withPermit({ agent: "a", action: "b" }, fn),
    ).rejects.toBeInstanceOf(AtlaSentDeniedError);

    expect(fn).not.toHaveBeenCalled();
    // No verifyPermit round-trip on deny.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not invoke fn when verifyPermit reports the permit was already consumed (replay)", async () => {
    // The v1 server consumes a permit on first verifyPermit. A second
    // verify on the same permit id returns verified:false with
    // outcome: 'permit_consumed'. This is the replay-attack path:
    // even if a caller retains the request shape and re-invokes
    // withPermit, the server-side single-use semantics mean the
    // wrapped fn never runs the second time.
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_CONSUMED_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const fn = vi.fn(async () => "should-not-run");

    let caught: unknown;
    try {
      await withPermit({ agent: "a", action: "b" }, fn);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtlaSentDeniedError);
    const denied = caught as AtlaSentDeniedError;
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("permit_consumed");
    expect(fn).not.toHaveBeenCalled();
  });

  it("propagates errors thrown by fn after the permit is verified", async () => {
    // v1 has no compensating revoke — once verifyPermit succeeds the
    // permit is consumed. If fn throws, the SDK surfaces fn's error
    // rather than swallowing it; the operator's audit log already
    // shows the permit was issued and verified.
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const userError = new Error("downstream-action-blew-up");
    const fn = vi.fn(async () => {
      throw userError;
    });

    let caught: unknown;
    try {
      await withPermit({ agent: "a", action: "b" }, fn);
    } catch (err) {
      caught = err;
    }

    // Caller's exception preserved verbatim — not wrapped in
    // AtlaSentError, not converted to a denied decision.
    expect(caught).toBe(userError);
    expect(caught).not.toBeInstanceOf(AtlaSentError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("supports synchronous fn return values", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const result = await withPermit(
      { agent: "a", action: "b" },
      (permit) => permit.permitId.toUpperCase(),
    );

    expect(result).toBe("DEC_ALPHA");
  });

  it("propagates AtlaSentError on transport failure — fn never runs", async () => {
    // 5xx on evaluate. Same fail-closed semantics as protect().
    const fetchImpl = vi.fn(async () =>
      new Response("upstream burned", { status: 502 }),
    ) as unknown as FetchMock;
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const fn = vi.fn(async () => "should-not-run");

    await expect(
      withPermit({ agent: "a", action: "b" }, fn),
    ).rejects.toBeInstanceOf(AtlaSentError);

    expect(fn).not.toHaveBeenCalled();
  });
});
