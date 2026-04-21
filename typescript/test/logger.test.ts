import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AtlaSentClient,
  consoleLogger,
  noopLogger,
  type Logger,
} from "../src/index.js";

describe("noopLogger", () => {
  it("implements all four levels without throwing or returning anything", () => {
    expect(noopLogger.debug("x")).toBeUndefined();
    expect(noopLogger.info("x", { a: 1 })).toBeUndefined();
    expect(noopLogger.warn("x")).toBeUndefined();
    expect(noopLogger.error("x")).toBeUndefined();
  });
});

describe("consoleLogger", () => {
  // `any` sidesteps vitest version-specific generics on spyOn's return type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spy: any;
  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it("emits one JSON line to stderr per call, with structured fields", () => {
    consoleLogger.info("hello", { agent: "a", action: "b" });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.logger).toBe("atlasent");
    expect(parsed.msg).toBe("hello");
    expect(parsed.agent).toBe("a");
    expect(parsed.action).toBe("b");
    expect(typeof parsed.ts).toBe("string");
  });

  it("routes each level to the right `level` field", () => {
    consoleLogger.debug("d");
    consoleLogger.warn("w");
    consoleLogger.error("e");
    const levels = (spy.mock.calls as unknown[][]).map(
      (c) => JSON.parse(c[0] as string).level,
    );
    expect(levels).toEqual(["debug", "warn", "error"]);
  });
});

describe("client logger integration", () => {
  function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  }

  function captureLogger(): {
    logger: Logger;
    calls: Array<{ level: string; msg: string; fields: Record<string, unknown> | undefined }>;
  } {
    const calls: Array<{ level: string; msg: string; fields: Record<string, unknown> | undefined }> = [];
    const push = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
      calls.push({ level, msg, fields });
    };
    return {
      logger: {
        debug: push("debug"),
        info: push("info"),
        warn: push("warn"),
        error: push("error"),
      },
      calls,
    };
  }

  it("info-logs an ALLOW decision with permitId", async () => {
    const { logger, calls } = captureLogger();
    const client = new AtlaSentClient({
      apiKey: "ask_live_test",
      logger,
      fetch: vi.fn(async () =>
        jsonResponse({
          permitted: true,
          decision_id: "dec_ok",
          reason: "ok",
          audit_hash: "h",
          timestamp: "t",
        }),
      ) as unknown as typeof fetch,
    });
    await client.evaluate({ agent: "a", action: "b" });
    const allow = calls.find((c) => c.msg === "evaluate permitted");
    expect(allow).toBeDefined();
    expect(allow?.level).toBe("info");
    expect(allow?.fields?.permitId).toBe("dec_ok");
  });

  it("warn-logs a DENY decision with reason", async () => {
    const { logger, calls } = captureLogger();
    const client = new AtlaSentClient({
      apiKey: "ask_live_test",
      logger,
      fetch: vi.fn(async () =>
        jsonResponse({
          permitted: false,
          decision_id: "dec_no",
          reason: "policy blocks this",
          audit_hash: "",
          timestamp: "",
        }),
      ) as unknown as typeof fetch,
    });
    await client.evaluate({ agent: "a", action: "b" });
    const deny = calls.find((c) => c.msg === "evaluate denied");
    expect(deny?.level).toBe("warn");
    expect(deny?.fields?.reason).toBe("policy blocks this");
  });

  it("warn-logs each retry with attempt/maxAttempts/code", async () => {
    const { logger, calls } = captureLogger();
    const responses: Array<() => Response> = [
      () => new Response("boom", { status: 500 }),
      () =>
        jsonResponse({
          permitted: true,
          decision_id: "dec_ok",
          reason: "",
          audit_hash: "",
          timestamp: "",
        }),
    ];
    let i = 0;
    const client = new AtlaSentClient({
      apiKey: "ask_live_test",
      logger,
      maxRetries: 1,
      retryBackoffMs: 1,
      sleep: async () => {},
      fetch: vi.fn(async () => responses[i++]!()) as unknown as typeof fetch,
    });
    await client.evaluate({ agent: "a", action: "b" });
    const retry = calls.find((c) => c.msg === "request retrying");
    expect(retry?.level).toBe("warn");
    expect(retry?.fields?.attempt).toBe(1);
    expect(retry?.fields?.code).toBe("server_error");
  });
});
