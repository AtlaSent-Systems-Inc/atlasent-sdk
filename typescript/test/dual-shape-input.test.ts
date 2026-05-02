/**
 * Tests for the TypeScript dual-shape input bridge (PR2).
 *
 * The SDK accepts both the canonical input names
 * (actorId, actionType, permitToken) and the legacy
 * (agent, action, permitId). Legacy names emit a one-time-per-process
 * deprecation warning via console.warn. The wire output is always
 * canonical regardless of which input shape was used.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import { AtlaSentClient } from "../src/index.js";

type FetchMock = MockedFunction<typeof fetch>;

const EVALUATE_PERMIT_WIRE = {
  decision: "allow",
  permit_token: "pt_dual_shape",
  request_id: "req_dual_shape",
};

const VERIFY_OK_WIRE = {
  valid: true,
  outcome: "allow",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function mockFetch(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchMock {
  return vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return impl(url, init ?? {});
  }) as unknown as FetchMock;
}

function makeClient(fetchImpl: FetchMock): AtlaSentClient {
  return new AtlaSentClient({
    apiKey: "ask_live_test",
    fetch: fetchImpl,
    timeoutMs: 5_000,
  });
}

describe("evaluate() dual-shape input", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("canonical actorId + actionType: wire is canonical, no deprecation", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    const client = makeClient(fetchImpl);
    await client.evaluate({
      actorId: "agent-1",
      actionType: "deploy",
      context: { env: "prod" },
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({
      action_type: "deploy",
      actor_id: "agent-1",
      context: { env: "prod" },
    });
    const deprecations = warnSpy.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("deprecated"),
    );
    expect(deprecations).toEqual([]);
  });

  it("legacy agent + action: wire is canonical (translated)", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    const client = makeClient(fetchImpl);
    await client.evaluate({
      agent: "agent-1",
      action: "deploy",
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.action_type).toBe("deploy");
    expect(body.actor_id).toBe("agent-1");
  });

  it("mixed canonical + legacy with same value: accepted", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    const client = makeClient(fetchImpl);
    await client.evaluate({
      actorId: "agent-1",
      agent: "agent-1",
      actionType: "deploy",
      action: "deploy",
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.action_type).toBe("deploy");
    expect(body.actor_id).toBe("agent-1");
  });

  it("mixed canonical + legacy with different values: throws", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    const client = makeClient(fetchImpl);
    await expect(
      client.evaluate({
        actorId: "agent-1",
        agent: "agent-different",
        actionType: "deploy",
      }),
    ).rejects.toThrow(/different values/);
  });

  it("missing both canonical and legacy: throws", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    const client = makeClient(fetchImpl);
    await expect(client.evaluate({})).rejects.toThrow(/Missing required field/);
  });
});

describe("verifyPermit() dual-shape input", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("canonical permitToken: wire is canonical", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(VERIFY_OK_WIRE));
    const client = makeClient(fetchImpl);
    await client.verifyPermit({
      permitToken: "pt_xyz",
      actorId: "agent-1",
      actionType: "deploy",
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({
      permit_token: "pt_xyz",
      action_type: "deploy",
      actor_id: "agent-1",
    });
  });

  it("legacy permitId / agent / action: wire is canonical", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(VERIFY_OK_WIRE));
    const client = makeClient(fetchImpl);
    await client.verifyPermit({
      permitId: "pt_xyz",
      action: "deploy",
      agent: "agent-1",
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.permit_token).toBe("pt_xyz");
    expect(body.action_type).toBe("deploy");
    expect(body.actor_id).toBe("agent-1");
  });

  it("legacy non-empty context: omitted from wire (with deprecation warning)", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(VERIFY_OK_WIRE));
    const client = makeClient(fetchImpl);
    await client.verifyPermit({
      permitToken: "pt_xyz",
      context: { still: "passed" },
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.context).toBeUndefined();
  });

  it("missing both permitToken and permitId: throws", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(VERIFY_OK_WIRE));
    const client = makeClient(fetchImpl);
    await expect(client.verifyPermit({})).rejects.toThrow(/Missing required field/);
  });
});
