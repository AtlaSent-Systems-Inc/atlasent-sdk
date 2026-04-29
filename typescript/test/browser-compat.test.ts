// @vitest-environment jsdom
/**
 * Browser-environment smoke tests.
 *
 * Runs under jsdom and stubs out `process` to simulate a browser where
 * Node globals are absent. Verifies that AtlaSentClient constructs and
 * makes requests without referencing process.version.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlaSentClient } from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EVALUATE_ALLOW_WIRE = {
  permitted: true,
  decision_id: "dec_browser_test",
  reason: "ok",
  audit_hash: "h1",
  timestamp: "2026-04-29T00:00:00Z",
};

describe("browser-compat — process stubbed to undefined", () => {
  it("AtlaSentClient constructs without throwing when process is absent", () => {
    vi.stubGlobal("process", undefined);
    expect(
      () =>
        new AtlaSentClient({
          apiKey: "ask_browser_test",
          fetch: vi.fn(),
        }),
    ).not.toThrow();
  });

  it("evaluate() emits a browser User-Agent when process is absent", async () => {
    vi.stubGlobal("process", undefined);

    let capturedUA = "";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedUA = (init?.headers as Record<string, string>)?.["User-Agent"] ?? "";
      return jsonResponse(EVALUATE_ALLOW_WIRE);
    });

    const client = new AtlaSentClient({
      apiKey: "ask_browser_test",
      fetch: fetchMock,
    });

    const result = await client.evaluate({ agent: "user:1", action: "read" });
    expect(result.decision).toBe("ALLOW");
    expect(result.permitId).toBe("dec_browser_test");
    expect(capturedUA).toMatch(/^@atlasent\/sdk\/\S+ browser$/);
    expect(capturedUA).not.toContain("node/");
  });

  it("evaluate() emits a node User-Agent when process is present", async () => {
    let capturedUA = "";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedUA = (init?.headers as Record<string, string>)?.["User-Agent"] ?? "";
      return jsonResponse(EVALUATE_ALLOW_WIRE);
    });

    const client = new AtlaSentClient({
      apiKey: "ask_node_test",
      fetch: fetchMock,
    });

    await client.evaluate({ agent: "user:1", action: "read" });
    expect(capturedUA).toMatch(/^@atlasent\/sdk\/\S+ node\//);
  });
});
