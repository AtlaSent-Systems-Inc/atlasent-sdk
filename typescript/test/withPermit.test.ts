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
  type ProtectRequest,
} from "../src/index.js";
import { __resetSharedClientForTests } from "../src/protect.js";

type FetchMock = MockedFunction<typeof fetch>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EVALUATE_ALLOW_WIRE = {
  permitted: true,
  decision_id: "dec_alpha",
  reason: "policy authorized",
  audit_hash: "hash_alpha",
  timestamp: "2026-04-22T10:00:00Z",
};

const EVALUATE_DENY_WIRE = {
  permitted: false,
  decision_id: "dec_beta",
  reason: "denied by policy",
  audit_hash: "hash_beta",
  timestamp: "2026-04-22T10:01:00Z",
};

const VERIFY_OK_WIRE = {
  verified: true,
  outcome: "verified",
  permit_hash: "permit_alpha",
  timestamp: "2026-04-22T10:00:01Z",
};

const VERIFY_REVOKED_WIRE = {
  verified: false,
  outcome: "revoked",
  permit_hash: "permit_alpha",
  timestamp: "2026-04-22T10:00:01Z",
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

const SAMPLE_REQUEST: ProtectRequest = {
  agent: "deploy-bot",
  action: "production.deploy",
  context: { commit: "abc123", environment: "production" },
};

// ── withPermit ────────────────────────────────────────────────────────────────

describe("withPermit", () => {
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

  it("invokes the body with the verified permit and returns its result", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const seen: Permit[] = [];
    const result = await withPermit(SAMPLE_REQUEST, async (permit) => {
      seen.push(permit);
      return "side-effect-done";
    });

    expect(result).toBe("side-effect-done");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.permitId).toBe("dec_alpha");
    expect(seen[0]!.permitHash).toBe("permit_alpha");
    expect(seen[0]!.auditHash).toBe("hash_alpha");
    expect(fetchImpl).toHaveBeenCalledTimes(2); // evaluate + verifyPermit
  });

  it("never invokes the body on policy deny", async () => {
    const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
    configure({
      apiKey: "ask_live_test",
      fetch: fetchImpl,
      retryPolicy: { maxAttempts: 1 },
    });

    const body = vi.fn(async () => "should-not-run");

    let caught: unknown;
    try {
      await withPermit(SAMPLE_REQUEST, body);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtlaSentDeniedError);
    expect(body).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never invokes the body when permit verification fails", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_REVOKED_WIRE),
    ]);
    configure({
      apiKey: "ask_live_test",
      fetch: fetchImpl,
      retryPolicy: { maxAttempts: 1 },
    });

    const body = vi.fn(async () => "should-not-run");

    let caught: unknown;
    try {
      await withPermit(SAMPLE_REQUEST, body);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtlaSentDeniedError);
    expect(body).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never invokes the body on transport failure", async () => {
    const fetchImpl = mockFetchSequence([
      new Response("internal server error", { status: 500 }),
    ]);
    configure({
      apiKey: "ask_live_test",
      fetch: fetchImpl,
      retryPolicy: { maxAttempts: 1 },
    });

    const body = vi.fn(async () => "should-not-run");

    let caught: unknown;
    try {
      await withPermit(SAMPLE_REQUEST, body);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtlaSentError);
    expect(caught).not.toBeInstanceOf(AtlaSentDeniedError);
    expect(body).not.toHaveBeenCalled();
  });

  it("propagates errors thrown inside the body untouched", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    class BodyError extends Error {}

    let caught: unknown;
    try {
      await withPermit(SAMPLE_REQUEST, async () => {
        throw new BodyError("downstream blew up");
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BodyError);
    // Permit was already minted and verified before the body ran;
    // the error from the body must not be wrapped as a deny.
    expect(caught).not.toBeInstanceOf(AtlaSentDeniedError);
    expect(caught).not.toBeInstanceOf(AtlaSentError);
  });

  it("accepts a synchronous body and awaits its return value", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const result = await withPermit(SAMPLE_REQUEST, (permit) => ({
      permitId: permit.permitId,
      ok: true,
    }));

    expect(result).toEqual({ permitId: "dec_alpha", ok: true });
  });

  it("preserves the body's return type generically", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const result: { deleted: boolean; id: string } = await withPermit(
      SAMPLE_REQUEST,
      async () => ({ deleted: true, id: "row_1" }),
    );

    expect(result).toEqual({ deleted: true, id: "row_1" });
  });

  it("forwards agent, action, and context unchanged to the evaluate body", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    await withPermit(SAMPLE_REQUEST, async () => undefined);

    const [, evalInit] = fetchImpl.mock.calls[0]!;
    const evalBody = JSON.parse(evalInit!.body as string);

    expect(evalBody.action_type).toBe(SAMPLE_REQUEST.action);
    expect(evalBody.actor_id).toBe(SAMPLE_REQUEST.agent);
    expect(evalBody.context.commit).toBe("abc123");
    expect(evalBody.context.environment).toBe("production");
  });
});
