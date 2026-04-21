import { describe, expect, it, vi, type MockedFunction } from "vitest";

import {
  AtlaSentClient,
  PermissionDeniedError,
  expressGuard,
  fastifyGuard,
  guard,
  type ExpressLikeNext,
  type ExpressLikeRequest,
} from "../src/index.js";

type FetchMock = MockedFunction<typeof fetch>;

const PERMIT_WIRE = {
  permitted: true,
  decision_id: "dec_alpha",
  reason: "ok",
  audit_hash: "hash_alpha",
  timestamp: "t",
};

const DENY_WIRE = {
  permitted: false,
  decision_id: "dec_deny",
  reason: "policy blocks this",
  audit_hash: "",
  timestamp: "t",
};

const VERIFY_OK_WIRE = {
  verified: true,
  outcome: "verified",
  permit_hash: "permit_alpha",
  timestamp: "t",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function scriptedFetch(
  responses: Array<() => Response | Promise<Response>>,
): FetchMock {
  let i = 0;
  return vi.fn(async () => {
    const handler = responses[i++];
    if (!handler) throw new Error(`scriptedFetch: no response for call ${i}`);
    return handler();
  }) as unknown as FetchMock;
}

function permittedClient(): AtlaSentClient {
  return new AtlaSentClient({
    apiKey: "ask_live_test",
    maxRetries: 0,
    sleep: async () => {},
    fetch: scriptedFetch([
      () => jsonResponse(PERMIT_WIRE),
      () => jsonResponse(VERIFY_OK_WIRE),
    ]),
  });
}

function deniedClient(): AtlaSentClient {
  return new AtlaSentClient({
    apiKey: "ask_live_test",
    maxRetries: 0,
    sleep: async () => {},
    fetch: scriptedFetch([() => jsonResponse(DENY_WIRE)]),
  });
}

describe("guard() (generic HOF)", () => {
  it("runs the handler on permit and attaches req.atlasent", async () => {
    interface MyReq extends ExpressLikeRequest {
      userId: string;
    }
    const handler = vi.fn((req: MyReq) => `ok:${req.atlasent?.verification.permitHash}`);
    const wrapped = guard<MyReq, string>(
      permittedClient(),
      {
        action: "modify_patient_record",
        agent: (req) => req.userId,
        context: (req) => ({ userId: req.userId }),
      },
      handler,
    );
    const req: MyReq = { userId: "dr_smith" };
    const out = await wrapped(req);
    expect(out).toBe("ok:permit_alpha");
    expect(req.atlasent?.verification.verified).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("throws PermissionDeniedError on deny (handler not invoked)", async () => {
    const handler = vi.fn(() => "should-not-run");
    const wrapped = guard(
      deniedClient(),
      { action: "modify_patient_record", agent: "a" },
      handler,
    );
    await expect(wrapped({})).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts a string for `action` (no resolver needed)", async () => {
    const wrapped = guard(
      permittedClient(),
      { action: "a", agent: "b" },
      async (_req) => "done",
    );
    await expect(wrapped({})).resolves.toBe("done");
  });
});

describe("expressGuard()", () => {
  it("calls next() with no argument on permit and populates req.atlasent", async () => {
    const next = vi.fn() as ExpressLikeNext & MockedFunction<ExpressLikeNext>;
    const middleware = expressGuard(permittedClient(), {
      action: "modify_patient_record",
      agent: "dr_smith",
    });
    const req: ExpressLikeRequest = {};
    middleware(req, {}, next);
    // Settle the promise chain inside the middleware.
    await new Promise((r) => setImmediate(r));
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]).toEqual([]);
    expect(req.atlasent?.evaluation.permitId).toBe("dec_alpha");
    expect(req.atlasent?.verification.permitHash).toBe("permit_alpha");
  });

  it("calls next(err) on deny", async () => {
    const next = vi.fn() as ExpressLikeNext & MockedFunction<ExpressLikeNext>;
    const middleware = expressGuard(deniedClient(), {
      action: "modify_patient_record",
    });
    middleware({}, {}, next);
    await new Promise((r) => setImmediate(r));
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]![0]).toBeInstanceOf(PermissionDeniedError);
  });

  it("resolves action/agent per-request from the req object", async () => {
    const fetchImpl = scriptedFetch([
      () => jsonResponse(PERMIT_WIRE),
      () => jsonResponse(VERIFY_OK_WIRE),
    ]);
    const client = new AtlaSentClient({
      apiKey: "ask_live_test",
      fetch: fetchImpl,
      maxRetries: 0,
      sleep: async () => {},
    });
    interface MyReq extends ExpressLikeRequest {
      params: { id: string };
      user: { id: string };
    }
    const middleware = expressGuard<MyReq>(client, {
      action: (req) => `read:${req.params.id}`,
      agent: (req) => req.user.id,
      context: (req) => ({ resourceId: req.params.id }),
    });
    const req: MyReq = {
      params: { id: "PT-001" },
      user: { id: "dr_smith" },
    };
    const next = vi.fn() as ExpressLikeNext & MockedFunction<ExpressLikeNext>;
    middleware(req, {}, next);
    await new Promise((r) => setImmediate(r));
    const body = JSON.parse(
      (fetchImpl.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.action).toBe("read:PT-001");
    expect(body.agent).toBe("dr_smith");
    expect(body.context).toEqual({ resourceId: "PT-001" });
  });
});

describe("fastifyGuard()", () => {
  it("attaches req.atlasent on permit", async () => {
    const pre = fastifyGuard(permittedClient(), {
      action: "modify_patient_record",
      agent: "dr_smith",
    });
    const req: ExpressLikeRequest = {};
    await pre(req);
    expect(req.atlasent?.verification.verified).toBe(true);
  });

  it("rejects with PermissionDeniedError on deny", async () => {
    const pre = fastifyGuard(deniedClient(), { action: "x" });
    await expect(pre({})).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
