import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  atlaSentGuard,
  atlaSentErrorHandler,
} from "../src/express.js";
import { AtlaSentDeniedError, AtlaSentError } from "../src/errors.js";
import { configure, __resetSharedClientForTests } from "../src/protect.js";

function makeReq(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { headers: {}, body: {}, params: {}, query: {}, ...overrides };
}

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; _status: number; _body: unknown } {
  const res = {
    _status: 200,
    _body: null as unknown,
    status: vi.fn().mockReturnThis() as ReturnType<typeof vi.fn>,
    json: vi.fn().mockReturnThis() as ReturnType<typeof vi.fn>,
  };
  res.status.mockImplementation((code: number) => { res._status = code; return res; });
  res.json.mockImplementation((body: unknown) => { res._body = body; return res; });
  return res;
}

const EVAL_ALLOW = {
  permitted: true,
  decision_id: "dec_express_1",
  reason: "allowed",
  audit_hash: "hash_ex1",
  timestamp: "2026-01-01T00:00:00Z",
};

const EVAL_DENY = {
  permitted: false,
  decision_id: "dec_express_2",
  reason: "policy denied",
  audit_hash: "hash_ex2",
  timestamp: "2026-01-01T00:00:01Z",
};

const VERIFY_OK = {
  verified: true,
  outcome: "verified",
  permit_hash: "ph_express_1",
  timestamp: "2026-01-01T00:00:02Z",
};

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetchQueue(responses: unknown[]): typeof globalThis.fetch {
  const queue = responses.map((r) => jsonResp(r));
  return vi.fn().mockImplementation(() => {
    const next = queue.shift();
    if (!next) throw new Error("mock fetch queue exhausted");
    return Promise.resolve(next);
  }) as unknown as typeof globalThis.fetch;
}

describe("atlaSentGuard middleware", () => {
  beforeEach(() => {
    __resetSharedClientForTests();
    configure({ apiKey: "ask_test_express_k1", retryPolicy: { maxAttempts: 1 } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetSharedClientForTests();
  });

  it("attaches permit to req and calls next() on allow", async () => {
    globalThis.fetch = makeFetchQueue([EVAL_ALLOW, VERIFY_OK]);
    const guard = atlaSentGuard({ action: "production.deploy", agent: "bot" });
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    await guard(req as never, res as never, next);
    expect(next).toHaveBeenCalledWith();
    expect((req as Record<string, unknown>)["atlasent"]).toBeDefined();
  });

  it("calls next(err) on denial", async () => {
    globalThis.fetch = makeFetchQueue([EVAL_DENY]);
    const guard = atlaSentGuard({ action: "production.deploy", agent: "bot" });
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    await guard(req as never, res as never, next);
    expect(next).toHaveBeenCalledWith(expect.any(AtlaSentDeniedError));
  });

  it("resolves agent and action from functions", async () => {
    globalThis.fetch = makeFetchQueue([EVAL_ALLOW, VERIFY_OK]);
    const guard = atlaSentGuard({
      action: (req) => (req as unknown as Record<string, unknown>)["action"] as string,
      agent: (req) => (req as unknown as Record<string, unknown>)["agent"] as string,
    });
    const req = makeReq({ action: "data.read", agent: "user-1" });
    const next = vi.fn();
    await guard(req as never, makeRes() as never, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("attaches context to protect request when context function provided", async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      const queue = [jsonResp(EVAL_ALLOW), jsonResp(VERIFY_OK)];
      let i = 0;
      return Promise.resolve(queue[i++]);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const guard = atlaSentGuard({
      action: "data.read",
      agent: "user-1",
      context: async (req) => ({ region: (req as unknown as Record<string, unknown>)["region"] }),
    });
    const req = makeReq({ region: "us-east-1" });
    const next = vi.fn();
    await guard(req as never, makeRes() as never, next);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.context?.region).toBe("us-east-1");
  });

  it("uses custom key on req", async () => {
    globalThis.fetch = makeFetchQueue([EVAL_ALLOW, VERIFY_OK]);
    const guard = atlaSentGuard({ action: "x.y", agent: "bot", key: "myPermit" });
    const req = makeReq();
    const next = vi.fn();
    await guard(req as never, makeRes() as never, next);
    expect((req as Record<string, unknown>)["myPermit"]).toBeDefined();
    expect((req as Record<string, unknown>)["atlasent"]).toBeUndefined();
  });

  it("calls next(err) on transport error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const guard = atlaSentGuard({ action: "x.y", agent: "bot" });
    const next = vi.fn();
    await guard(makeReq() as never, makeRes() as never, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("atlaSentErrorHandler", () => {
  it("responds 403 with deny body for AtlaSentDeniedError", () => {
    const handler = atlaSentErrorHandler();
    const err = new AtlaSentDeniedError({
      decision: "deny",
      evaluationId: "eval_1",
      reason: "policy block",
    });
    const res = makeRes();
    const next = vi.fn();
    handler(err, makeReq() as never, res as never, next);
    expect(res._status).toBe(403);
    expect(res._body).toMatchObject({ error: "denied", decision: "deny" });
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 503 for AtlaSentError", () => {
    const handler = atlaSentErrorHandler();
    const err = new AtlaSentError("Service unavailable", { code: "server_error" });
    const res = makeRes();
    const next = vi.fn();
    handler(err, makeReq() as never, res as never, next);
    expect(res._status).toBe(503);
    expect(res._body).toMatchObject({ error: "unavailable" });
  });

  it("forwards non-AtlaSent errors to next", () => {
    const handler = atlaSentErrorHandler();
    const err = new Error("something else");
    const next = vi.fn();
    handler(err, makeReq() as never, makeRes() as never, next);
    expect(next).toHaveBeenCalledWith(err);
  });

  it("respects custom denyStatus and errorStatus options", () => {
    const handler = atlaSentErrorHandler({ denyStatus: 401, errorStatus: 502 });
    const deny = new AtlaSentDeniedError({ decision: "deny", evaluationId: "e1" });
    const svcErr = new AtlaSentError("x", { code: "network" });
    const res1 = makeRes(), res2 = makeRes();
    const next = vi.fn();
    handler(deny, makeReq() as never, res1 as never, next);
    handler(svcErr, makeReq() as never, res2 as never, next);
    expect(res1._status).toBe(401);
    expect(res2._status).toBe(502);
  });

  it("uses custom renderDeny and renderError functions", () => {
    const handler = atlaSentErrorHandler({
      renderDeny: () => ({ custom: "deny" }),
      renderError: () => ({ custom: "error" }),
    });
    const deny = new AtlaSentDeniedError({ decision: "deny", evaluationId: "e1" });
    const svcErr = new AtlaSentError("x", { code: "network" });
    const res1 = makeRes(), res2 = makeRes();
    const next = vi.fn();
    handler(deny, makeReq() as never, res1 as never, next);
    handler(svcErr, makeReq() as never, res2 as never, next);
    expect(res1._body).toEqual({ custom: "deny" });
    expect(res2._body).toEqual({ custom: "error" });
  });
});
