import { describe, it, expect, vi, beforeEach } from "vitest";
import { AtlaSentClient } from "./client.js";
import { AtlaSentDeniedError, AtlaSentHoldError, AtlaSentEscalateError, AtlaSentAPIError } from "./errors.js";

const BASE = "https://api.atlasent.io";

function mockFetch(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

let client: AtlaSentClient;

beforeEach(() => {
  client = new AtlaSentClient({ apiKey: "test-key", baseUrl: BASE });
});

describe("evaluate", () => {
  it("returns allow response", async () => {
    global.fetch = mockFetch({ decision: "allow", permitToken: "tok-123", meta: {} });
    const resp = await client.evaluate({ agentId: "a", actionType: "production.deploy", context: {}, failMode: "closed" });
    expect(resp.decision).toBe("allow");
    expect(resp.permitToken).toBe("tok-123");
  });

  it("throws AtlaSentAPIError on 401", async () => {
    global.fetch = mockFetch("Unauthorized", 401);
    await expect(client.evaluate({ agentId: "a", actionType: "x", context: {}, failMode: "closed" })).rejects.toBeInstanceOf(AtlaSentAPIError);
  });
});

describe("authorizeOrThrow", () => {
  it("throws AtlaSentDeniedError on deny", async () => {
    global.fetch = mockFetch({ decision: "deny", denyCode: "OUTSIDE_CHANGE_WINDOW", meta: {} });
    await expect(client.authorizeOrThrow({ agentId: "a", actionType: "production.deploy", context: {}, failMode: "closed" }))
      .rejects.toBeInstanceOf(AtlaSentDeniedError);
  });

  it("throws AtlaSentHoldError on hold", async () => {
    global.fetch = mockFetch({ decision: "hold", denyCode: "PENDING_REVIEW", meta: {} });
    await expect(client.authorizeOrThrow({ agentId: "a", actionType: "infra.terraform.apply", context: {}, failMode: "closed" }))
      .rejects.toBeInstanceOf(AtlaSentHoldError);
  });

  it("throws AtlaSentEscalateError on escalate", async () => {
    global.fetch = mockFetch({ decision: "escalate", escalateTo: "security-team", meta: {} });
    await expect(client.authorizeOrThrow({ agentId: "a", actionType: "data.export", context: {}, failMode: "closed" }))
      .rejects.toBeInstanceOf(AtlaSentEscalateError);
  });

  it("returns response on allow", async () => {
    global.fetch = mockFetch({ decision: "allow", permitToken: "tok", meta: {} });
    const resp = await client.authorizeOrThrow({ agentId: "a", actionType: "staging.deploy", context: {}, failMode: "closed" });
    expect(resp.decision).toBe("allow");
  });
});

describe("verifyPermit", () => {
  it("returns valid true", async () => {
    global.fetch = mockFetch({ valid: true });
    const resp = await client.verifyPermit({ permitToken: "tok", actionType: "production.deploy" });
    expect(resp.valid).toBe(true);
  });
});
