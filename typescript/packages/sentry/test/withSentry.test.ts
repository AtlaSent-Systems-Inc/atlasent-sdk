/**
 * Tests for the Sentry adapter.
 *
 * Strategy: stub `@sentry/core::addBreadcrumb` + `captureException`
 * with `vi.hoisted` + `vi.mock` so we capture every call without
 * actually shipping breadcrumbs to a Sentry server. Same pattern
 * as the OTel tests use for the tracer boundary.
 *
 * `AtlaSentClient` is stubbed via a hand-rolled fake (no `vi.mock`
 * needed) so the tests focus on the wrapper's instrumentation
 * behavior, not v1's internals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { addBreadcrumbMock, captureExceptionMock } = vi.hoisted(() => {
  return {
    addBreadcrumbMock: vi.fn(),
    captureExceptionMock: vi.fn(),
  };
});

vi.mock("@sentry/core", () => ({
  addBreadcrumb: addBreadcrumbMock,
  captureException: captureExceptionMock,
}));

import { withSentry, wrapProtect } from "../src/withSentry.js";
import type { AtlaSentClient } from "@atlasent/sdk";

beforeEach(() => {
  addBreadcrumbMock.mockClear();
  captureExceptionMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

function fakeClient(impl: Partial<AtlaSentClient>): AtlaSentClient {
  return impl as AtlaSentClient;
}

function lastBreadcrumb() {
  const call = addBreadcrumbMock.mock.calls.at(-1);
  if (!call) throw new Error("no breadcrumb captured");
  return call[0];
}

// ── evaluate ────────────────────────────────────────────────────────


describe("withSentry — evaluate", () => {
  it("emits an info breadcrumb with agent / action / decision", async () => {
    const client = withSentry(
      fakeClient({
        evaluate: async () => ({
          decision: "ALLOW",
          permitId: "dec_abc",
          reason: "ok",
          auditHash: "h".repeat(64),
          timestamp: "t",
          rateLimit: null,
        }),
      }),
    );

    await client.evaluate({ agent: "deploy-bot", action: "deploy" });

    const bc = lastBreadcrumb();
    expect(bc.category).toBe("atlasent");
    expect(bc.message).toBe("evaluate");
    expect(bc.level).toBe("info");
    expect(bc.data).toMatchObject({
      agent: "deploy-bot",
      action: "deploy",
      decision: "ALLOW",
      permit_id: "dec_abc",
      audit_hash: "h".repeat(64),
    });
  });

  it("emits an error breadcrumb on throw with error_code + request_id", async () => {
    class MockError extends Error {
      code = "rate_limited";
      requestId = "req_42";
    }
    const client = withSentry(
      fakeClient({
        evaluate: async () => {
          throw new MockError("rate limited");
        },
      }),
    );

    await expect(
      client.evaluate({ agent: "a", action: "b" }),
    ).rejects.toThrow("rate limited");

    const bc = lastBreadcrumb();
    expect(bc.level).toBe("error");
    expect(bc.data).toMatchObject({
      agent: "a",
      action: "b",
      error_code: "rate_limited",
      request_id: "req_42",
      error_message: "rate limited",
    });
    // `captureErrors` defaulted to false → no exception capture.
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("captures exceptions when captureErrors is true", async () => {
    const err = new Error("boom");
    const client = withSentry(
      fakeClient({
        evaluate: async () => {
          throw err;
        },
      }),
      { captureErrors: true },
    );

    await expect(
      client.evaluate({ agent: "a", action: "b" }),
    ).rejects.toBe(err);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(err);
  });

  it("merges extraData onto every breadcrumb", async () => {
    const client = withSentry(
      fakeClient({
        evaluate: async () => ({
          decision: "ALLOW",
          permitId: "p",
          reason: "",
          auditHash: "",
          timestamp: "",
          rateLimit: null,
        }),
      }),
      { extraData: { service: "deploy-bot", tenant: "acme" } },
    );

    await client.evaluate({ agent: "a", action: "b" });

    const bc = lastBreadcrumb();
    expect(bc.data).toMatchObject({
      service: "deploy-bot",
      tenant: "acme",
      agent: "a",
      action: "b",
    });
  });
});

// ── verifyPermit ────────────────────────────────────────────────────


describe("withSentry — verifyPermit", () => {
  it("emits a breadcrumb with permit_id + verified", async () => {
    const client = withSentry(
      fakeClient({
        verifyPermit: async () => ({
          verified: true,
          outcome: "ok",
          permitHash: "h",
          timestamp: "t",
          rateLimit: null,
        }),
      }),
    );

    await client.verifyPermit({ permitId: "dec_abc" });

    const bc = lastBreadcrumb();
    expect(bc.message).toBe("verify_permit");
    expect(bc.data).toMatchObject({ permit_id: "dec_abc", verified: true });
  });

  it("verified: false stays an info breadcrumb (not an error)", async () => {
    const client = withSentry(
      fakeClient({
        verifyPermit: async () => ({
          verified: false,
          outcome: "expired",
          permitHash: "",
          timestamp: "t",
          rateLimit: null,
        }),
      }),
    );

    await client.verifyPermit({ permitId: "dec_abc" });

    const bc = lastBreadcrumb();
    expect(bc.level).toBe("info");
    expect(bc.data).toMatchObject({ verified: false });
  });
});

// ── keySelf ─────────────────────────────────────────────────────────


describe("withSentry — keySelf", () => {
  it("emits a breadcrumb with key_id + environment", async () => {
    const client = withSentry(
      fakeClient({
        keySelf: async () => ({
          keyId: "k1",
          organizationId: "org-1",
          environment: "live",
          scopes: [],
          allowedCidrs: null,
          rateLimitPerMinute: 1000,
          clientIp: null,
          expiresAt: null,
          rateLimit: null,
        }),
      }),
    );

    await client.keySelf();

    const bc = lastBreadcrumb();
    expect(bc.message).toBe("key_self");
    expect(bc.data).toMatchObject({ key_id: "k1", environment: "live" });
  });
});

// ── audit listing + export ──────────────────────────────────────────


describe("withSentry — audit methods", () => {
  it("listAuditEvents records event_count", async () => {
    const client = withSentry(
      fakeClient({
        listAuditEvents: async () => ({
          events: [{ id: "e1" }, { id: "e2" }, { id: "e3" }] as never[],
          total: 3,
          rateLimit: null,
        }),
      }),
    );

    await client.listAuditEvents();

    const bc = lastBreadcrumb();
    expect(bc.message).toBe("list_audit_events");
    expect(bc.data).toMatchObject({ event_count: 3 });
  });

  it("createAuditExport records export_id + event_count", async () => {
    const client = withSentry(
      fakeClient({
        createAuditExport: async () => ({
          export_id: "ex1",
          events: [{ id: "e1" }] as never[],
          rateLimit: null,
        } as never),
      }),
    );

    await client.createAuditExport();

    const bc = lastBreadcrumb();
    expect(bc.message).toBe("create_audit_export");
    expect(bc.data).toMatchObject({ export_id: "ex1", event_count: 1 });
  });
});

// ── wrapProtect ────────────────────────────────────────────────────


describe("wrapProtect", () => {
  it("emits a breadcrumb with permit_id + audit_hash on success", async () => {
    const protect = async (input: { agent: string; action: string }) => ({
      permit_id: "permit-1",
      audit_hash: "h",
      ignored: input,
    });

    const wrapped = wrapProtect({ protect });
    const result = await wrapped({ agent: "deploy-bot", action: "deploy" });

    expect(result.permit_id).toBe("permit-1");
    const bc = lastBreadcrumb();
    expect(bc.message).toBe("protect");
    expect(bc.data).toMatchObject({
      agent: "deploy-bot",
      action: "deploy",
      permit_id: "permit-1",
      audit_hash: "h",
    });
  });

  it("captures + emits error breadcrumb when captureErrors is true", async () => {
    const err = new Error("denied");
    const wrapped = wrapProtect({
      protect: async () => {
        throw err;
      },
      captureErrors: true,
    });

    await expect(wrapped({ agent: "a", action: "b" })).rejects.toBe(err);

    expect(captureExceptionMock).toHaveBeenCalledWith(err);
    const bc = lastBreadcrumb();
    expect(bc.level).toBe("error");
  });

  it("handles non-object protect() return values without crashing", async () => {
    const wrapped = wrapProtect({
      protect: async () => null as unknown,
    });
    await wrapped({ agent: "a", action: "b" });
    const bc = lastBreadcrumb();
    // No permit_id on the data since the result didn't have one.
    expect(bc.data?.permit_id).toBeUndefined();
  });
});

// ── error helper edge cases ────────────────────────────────────────


describe("error data extraction", () => {
  it("non-Error throws still yield a breadcrumb (sans error_message)", async () => {
    const client = withSentry(
      fakeClient({
        evaluate: async () => {
          throw "string error"; // eslint-disable-line @typescript-eslint/no-throw-literal
        },
      }),
    );

    await expect(
      client.evaluate({ agent: "a", action: "b" }),
    ).rejects.toBe("string error");

    const bc = lastBreadcrumb();
    expect(bc.level).toBe("error");
    expect(bc.data?.agent).toBe("a");
    // No error_message since the throw wasn't an Error instance.
    expect(bc.data?.error_message).toBeUndefined();
  });
});
