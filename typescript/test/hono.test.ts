import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";

import { Hono } from "hono";

import {
  AtlaSentDeniedError,
  AtlaSentError,
  atlaSentErrorHandler,
  atlaSentGuard,
} from "../src/hono.js";
import { configure, __resetSharedClientForTests, type Permit } from "../src/protect.js";

type AppEnv = { Variables: { atlasent: Permit; permit: Permit } };

type FetchMock = MockedFunction<typeof fetch>;

const EVALUATE_ALLOW_WIRE = {
  permitted: true,
  decision_id: "dec_alpha",
  reason: "allowed",
  audit_hash: "hash_alpha",
  timestamp: "2026-04-22T10:00:00Z",
};

const EVALUATE_DENY_WIRE = {
  permitted: false,
  decision_id: "dec_beta",
  reason: "missing approver",
  audit_hash: "hash_beta",
  timestamp: "2026-04-22T10:00:00Z",
};

const VERIFY_OK_WIRE = {
  verified: true,
  outcome: "verified",
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

describe("atlaSentGuard (Hono middleware)", () => {
  beforeEach(() => {
    __resetSharedClientForTests();
  });

  afterEach(() => {
    __resetSharedClientForTests();
  });

  it("allows the route to run on permit; exposes Permit via c.get('atlasent')", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const app = new Hono<AppEnv>();
    app.post(
      "/deploy",
      atlaSentGuard({ agent: "deploy-bot", action: "deploy_to_production" }),
      (c) => {
        const permit = c.get("atlasent");
        return c.json({ ok: true, permitId: permit.permitId });
      },
    );

    const res = await app.request("/deploy", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, permitId: "dec_alpha" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("accepts function resolvers for agent / action / context and forwards them", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const app = new Hono();
    app.post(
      "/deploy/:service",
      atlaSentGuard({
        agent: (c) => c.req.header("x-agent-id") ?? "anon",
        action: (c) => `deploy_${c.req.param("service")}`,
        context: async (c) => ({
          commit: (await c.req.json<{ commit: string }>()).commit,
          approver: c.req.header("x-approver") ?? "unknown",
        }),
      }),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request("/deploy/billing-api", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-id": "ci-runner-42",
        "x-approver": "alice",
      },
      body: JSON.stringify({ commit: "abc123" }),
    });
    expect(res.status).toBe(200);

    // First call → /v1-evaluate with resolved actor_id/action_type/context (canonical wire).
    const [, evalInit] = fetchImpl.mock.calls[0]!;
    const evalBody = JSON.parse(evalInit!.body as string);
    expect(evalBody.actor_id).toBe("ci-runner-42");
    expect(evalBody.action_type).toBe("deploy_billing-api");
    expect(evalBody.context).toEqual({ commit: "abc123", approver: "alice" });
  });

  it("on DENY, throws AtlaSentDeniedError — not caught inside the middleware", async () => {
    const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const app = new Hono();
    // Capture whatever app.onError sees so we can assert on the exception
    // itself without mixing in the HTTP response wrapping.
    let captured: unknown;
    app.onError((err, c) => {
      captured = err;
      return c.json({ caught: true }, 500);
    });

    app.post(
      "/deploy",
      atlaSentGuard({ agent: "bot", action: "deploy" }),
      (c) => c.json({ ok: true }),
    );

    await app.request("/deploy", { method: "POST" });
    expect(captured).toBeInstanceOf(AtlaSentDeniedError);
    const denied = captured as AtlaSentDeniedError;
    expect(denied.decision).toBe("deny");
    expect(denied.evaluationId).toBe("dec_beta");
    expect(denied.reason).toBe("missing approver");
  });

  it("uses a custom key when options.key is set", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const app = new Hono<AppEnv>();
    app.post(
      "/deploy",
      atlaSentGuard({ agent: "bot", action: "deploy", key: "permit" }),
      (c) => {
        expect(c.get("atlasent")).toBeUndefined();
        const permit = c.get("permit");
        return c.json({ permitId: permit.permitId });
      },
    );

    const res = await app.request("/deploy", { method: "POST" });
    expect(await res.json()).toEqual({ permitId: "dec_alpha" });
  });

  it("does not run the downstream handler when deny throws", async () => {
    const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const handlerSpy = vi.fn();
    const app = new Hono();
    app.onError((_err, c) => c.json({}, 403));
    app.post(
      "/deploy",
      atlaSentGuard({ agent: "bot", action: "deploy" }),
      (c) => {
        handlerSpy();
        return c.json({ ok: true });
      },
    );

    await app.request("/deploy", { method: "POST" });
    expect(handlerSpy).not.toHaveBeenCalled();
  });
});

describe("atlaSentErrorHandler", () => {
  beforeEach(() => {
    __resetSharedClientForTests();
  });

  afterEach(() => {
    __resetSharedClientForTests();
  });

  it("maps AtlaSentDeniedError → 403 with a default JSON body", async () => {
    const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const app = new Hono();
    app.onError(atlaSentErrorHandler());
    app.post(
      "/deploy",
      atlaSentGuard({ agent: "bot", action: "deploy" }),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request("/deploy", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "denied",
      decision: "deny",
      evaluationId: "dec_beta",
      reason: "missing approver",
    });
  });

  it("maps transport AtlaSentError → 503", async () => {
    const fetchImpl = mockFetchSequence([
      new Response("server boom", { status: 500 }),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const app = new Hono();
    app.onError(atlaSentErrorHandler());
    app.post(
      "/deploy",
      atlaSentGuard({ agent: "bot", action: "deploy" }),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request("/deploy", { method: "POST" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("unavailable");
    expect(body.code).toBe("server_error");
  });

  it("honours custom denyStatus / errorStatus / renderers", async () => {
    const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const app = new Hono();
    app.onError(
      atlaSentErrorHandler({
        denyStatus: 422,
        renderDeny: (err) => ({
          message: "Nope",
          detail: err.reason,
        }),
      }),
    );
    app.post(
      "/deploy",
      atlaSentGuard({ agent: "bot", action: "deploy" }),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request("/deploy", { method: "POST" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      message: "Nope",
      detail: "missing approver",
    });
  });

  it("re-throws non-AtlaSent errors so other onError chains still see them", async () => {
    const app = new Hono();
    // Inner chain: our handler. Outer chain: generic fallback that
    // catches the re-throw and returns 500 so we can prove it ran.
    app.onError((err, c) => {
      if (err.message === "custom failure") {
        return c.json({ rethrown: true }, 500);
      }
      return atlaSentErrorHandler()(err, c);
    });
    app.get("/boom", () => {
      throw new Error("custom failure");
    });

    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ rethrown: true });
  });
});
