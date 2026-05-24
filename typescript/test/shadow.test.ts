import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from "vitest";
import { configureShadow, protectShadow, reportShadowEvent } from "../src/shadow.js";
import { AtlaSentDeniedError } from "../src/errors.js";
import { configure, __resetSharedClientForTests } from "../src/protect.js";

type FetchMock = MockedFunction<typeof fetch>;

// ── Wire shapes ────────────────────────────────────────────────────────────────

const EVALUATE_ALLOW_WIRE = {
  permitted: true,
  decision_id: "dec_1",
  reason: "ok",
  audit_hash: "h1",
  timestamp: "2026-01-01T00:00:00Z",
};

const EVALUATE_DENY_WIRE = {
  permitted: false,
  decision_id: "dec_2",
  reason: "denied by policy",
  audit_hash: "h2",
  timestamp: "2026-01-01T00:00:01Z",
};

const VERIFY_OK_WIRE = {
  verified: true,
  outcome: "verified",
  permit_hash: "ph1",
  timestamp: "2026-01-01T00:00:02Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build a fetch mock that returns responses in sequence.
 * Each call pops the next entry from the queue.
 */
function mockFetchSequence(responses: Response[]): FetchMock {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("mock fetch queue exhausted");
    return next;
  }) as unknown as FetchMock;
}

// ── Test setup ─────────────────────────────────────────────────────────────────

describe("shadow module", () => {
  const ORIGINAL_API_KEY = process.env["ATLASENT_API_KEY"];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    // Reset the protect singleton so each test gets a clean client.
    __resetSharedClientForTests();
    // Reset shadow module config to a known-empty state.
    configureShadow({});
    process.env["ATLASENT_API_KEY"] = "ask_test_shadow_k1";
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    __resetSharedClientForTests();
    globalThis.fetch = originalFetch;
    if (ORIGINAL_API_KEY !== undefined) {
      process.env["ATLASENT_API_KEY"] = ORIGINAL_API_KEY;
    } else {
      delete process.env["ATLASENT_API_KEY"];
    }
    vi.restoreAllMocks();
  });

  // ── configureShadow ─────────────────────────────────────────────────────────

  describe("configureShadow()", () => {
    it("merges config so later keys win", async () => {
      const onOutcome1 = vi.fn();
      const onOutcome2 = vi.fn();
      configureShadow({ mode: "observe", onOutcome: onOutcome1 });
      configureShadow({ onOutcome: onOutcome2 });

      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      await protectShadow({ agent: "a", action: "b", context: { environment: "production" } });

      // The second configureShadow call replaced onOutcome; onOutcome2 fires.
      expect(onOutcome2).toHaveBeenCalledOnce();
      expect(onOutcome1).not.toHaveBeenCalled();
    });

    it("defaults mode to observe when not set", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      const outcome = await protectShadow({ agent: "a", action: "b", context: { environment: "production" } });
      expect(outcome.mode).toBe("observe");
    });
  });

  // ── observe mode ────────────────────────────────────────────────────────────

  describe("protectShadow() — observe mode", () => {
    it("returns a permit outcome on allow", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      const outcome = await protectShadow(
        { agent: "agent-x", action: "files.read", context: { environment: "production" } },
        { mode: "observe" },
      );

      expect(outcome.decision).toBe("permit");
      expect(outcome.would_have_blocked).toBe(false);
      expect(outcome.error).toBeNull();
      expect(outcome.mode).toBe("observe");
      expect(outcome.permit).not.toBeNull();
      expect(outcome.permit?.permitId).toBe("dec_1");
      expect(outcome.evaluationId).toBe("dec_1");
      expect(outcome.request).toEqual({ agent: "agent-x", action: "files.read", context: { environment: "production" } });
      expect(typeof outcome.latencyMs).toBe("number");
    });

    it("returns a deny outcome (does NOT throw) when protect() denies", async () => {
      const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      const outcome = await protectShadow(
        { agent: "agent-x", action: "files.delete", context: { environment: "production" } },
        { mode: "observe" },
      );

      expect(outcome.decision).toBe("deny");
      expect(outcome.would_have_blocked).toBe(true);
      expect(outcome.permit).toBeNull();
      expect(outcome.error).toBeInstanceOf(AtlaSentDeniedError);
      expect(outcome.mode).toBe("observe");
      expect(outcome.evaluationId).toBe("dec_2");
    });

    it("rethrows non-AtlaSentDeniedError exceptions in observe mode", async () => {
      const boom = new Error("network failure");
      configure({
        apiKey: "ask_test_shadow_k1",
        retryPolicy: { maxAttempts: 1 },
        fetch: vi.fn().mockRejectedValue(boom) as unknown as FetchMock,
      });

      await expect(
        protectShadow({ agent: "a", action: "b", context: { environment: "production" } }, { mode: "observe" }),
      ).rejects.toThrow("network failure");
    });

    it("sets would_have_blocked=false on permit outcome", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      const outcome = await protectShadow({ agent: "a", action: "b", context: { environment: "production" } }, { mode: "observe" });
      expect(outcome.would_have_blocked).toBe(false);
    });

    it("calls reportShadowEvent when reportToApi is true on permit", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(VERIFY_OK_WIRE),
        jsonResponse({}, 200), // shadow-events endpoint
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });
      globalThis.fetch = fetchImpl;

      await protectShadow(
        { agent: "a", action: "b", context: { environment: "production" } },
        { mode: "observe", reportToApi: true, apiKey: "ask_test_shadow_k1" },
      );

      // Give the fire-and-forget a tick to run.
      await new Promise((r) => setTimeout(r, 10));
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      const shadowCall = fetchImpl.mock.calls[2]!;
      expect((shadowCall[0] as string)).toContain("/v1/shadow-events");
    });

    it("calls reportShadowEvent when reportToApi is true on deny", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_DENY_WIRE),
        jsonResponse({}, 200), // shadow-events endpoint
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });
      globalThis.fetch = fetchImpl;

      await protectShadow(
        { agent: "a", action: "b", context: { environment: "production" } },
        { mode: "observe", reportToApi: true, apiKey: "ask_test_shadow_k1" },
      );

      await new Promise((r) => setTimeout(r, 10));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const shadowCall = fetchImpl.mock.calls[1]!;
      expect((shadowCall[0] as string)).toContain("/v1/shadow-events");
    });

    it("does NOT call reportShadowEvent when reportToApi is false", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });
      globalThis.fetch = fetchImpl;

      await protectShadow(
        { agent: "a", action: "b", context: { environment: "production" } },
        { mode: "observe", reportToApi: false },
      );

      await new Promise((r) => setTimeout(r, 10));
      // Only evaluate + verify — no shadow-events call.
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  // ── warn mode ───────────────────────────────────────────────────────────────

  describe("protectShadow() — warn mode", () => {
    it("logs console.warn when protect() denies, but does not throw", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      const outcome = await protectShadow(
        { agent: "agent-x", action: "files.delete", context: { environment: "production" } },
        { mode: "warn" },
      );

      expect(outcome.would_have_blocked).toBe(true);
      expect(outcome.decision).toBe("deny");
      const shadowWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes("shadow:warn"));
      expect(shadowWarns).toHaveLength(1);
      expect(shadowWarns[0]?.[0]).toMatch(/shadow:warn/);
      expect(shadowWarns[0]?.[0]).toMatch(/files\.delete/);
    });

    it("does NOT log console.warn when protect() permits", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      const outcome = await protectShadow(
        { agent: "a", action: "b", context: { environment: "production" } },
        { mode: "warn" },
      );

      expect(outcome.would_have_blocked).toBe(false);
      const shadowWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes("shadow:warn"));
      expect(shadowWarns).toHaveLength(0);
    });

    it("rethrows non-AtlaSentDeniedError exceptions in warn mode", async () => {
      const boom = new TypeError("unexpected failure");
      configure({
        apiKey: "ask_test_shadow_k1",
        retryPolicy: { maxAttempts: 1 },
        fetch: vi.fn().mockRejectedValue(boom) as unknown as FetchMock,
      });

      await expect(
        protectShadow({ agent: "a", action: "b", context: { environment: "production" } }, { mode: "warn" }),
      ).rejects.toThrow("unexpected failure");
    });

    it("includes evaluationId in warn log", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      await protectShadow({ agent: "a", action: "b", context: { environment: "production" } }, { mode: "warn" });
      const shadowWarn = warnSpy.mock.calls.find(([msg]) => String(msg).includes("shadow:warn"));
      expect(shadowWarn?.[0]).toMatch(/dec_2/);
    });
  });

  // ── enforce mode ────────────────────────────────────────────────────────────

  describe("protectShadow() — enforce mode", () => {
    it("returns a permit outcome on allow", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      const outcome = await protectShadow(
        { agent: "agent-x", action: "files.write", context: { environment: "production" } },
        { mode: "enforce" },
      );

      expect(outcome.decision).toBe("permit");
      expect(outcome.would_have_blocked).toBe(false);
      expect(outcome.error).toBeNull();
      expect(outcome.mode).toBe("enforce");
      expect(outcome.permit?.permitId).toBe("dec_1");
    });

    it("THROWS AtlaSentDeniedError when protect() denies in enforce mode", async () => {
      const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      await expect(
        protectShadow({ agent: "agent-x", action: "critical.action", context: { environment: "production" } }, { mode: "enforce" }),
      ).rejects.toBeInstanceOf(AtlaSentDeniedError);
    });

    it("does NOT suppress other errors in enforce mode", async () => {
      const boom = new Error("server exploded");
      configure({
        apiKey: "ask_test_shadow_k1",
        retryPolicy: { maxAttempts: 1 },
        fetch: vi.fn().mockRejectedValue(boom) as unknown as FetchMock,
      });

      await expect(
        protectShadow({ agent: "a", action: "b", context: { environment: "production" } }, { mode: "enforce" }),
      ).rejects.toThrow("server exploded");
    });

    it("sets would_have_blocked=false in enforce permit outcome", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      const outcome = await protectShadow({ agent: "a", action: "b", context: { environment: "production" } }, { mode: "enforce" });
      expect(outcome.would_have_blocked).toBe(false);
    });
  });

  // ── onOutcome callback ──────────────────────────────────────────────────────

  describe("onOutcome callback", () => {
    it("is called with the outcome on permit", async () => {
      const onOutcome = vi.fn();
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      const outcome = await protectShadow(
        { agent: "a", action: "b", context: { environment: "production" } },
        { mode: "observe", onOutcome },
      );

      expect(onOutcome).toHaveBeenCalledOnce();
      expect(onOutcome).toHaveBeenCalledWith(outcome);
    });

    it("is called with the outcome on deny", async () => {
      const onOutcome = vi.fn();
      const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      const outcome = await protectShadow(
        { agent: "a", action: "b", context: { environment: "production" } },
        { mode: "observe", onOutcome },
      );

      expect(onOutcome).toHaveBeenCalledOnce();
      expect(onOutcome).toHaveBeenCalledWith(outcome);
      expect(outcome.would_have_blocked).toBe(true);
    });

    it("is called in enforce mode on permit", async () => {
      const onOutcome = vi.fn();
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      await protectShadow({ agent: "a", action: "b", context: { environment: "production" } }, { mode: "enforce", onOutcome });
      expect(onOutcome).toHaveBeenCalledOnce();
    });

    it("silently suppresses errors thrown by onOutcome", async () => {
      const onOutcome = vi.fn().mockRejectedValue(new Error("callback exploded"));
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      // Should not throw despite onOutcome throwing.
      await expect(
        protectShadow({ agent: "a", action: "b", context: { environment: "production" } }, { mode: "observe", onOutcome }),
      ).resolves.toBeDefined();
    });

    it("silently suppresses errors thrown by onOutcome on deny", async () => {
      const onOutcome = vi.fn().mockRejectedValue(new Error("callback exploded on deny"));
      const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      await expect(
        protectShadow({ agent: "a", action: "b", context: { environment: "production" } }, { mode: "observe", onOutcome }),
      ).resolves.toBeDefined();
    });

    it("uses onOutcome from configureShadow when not provided in opts", async () => {
      const onOutcome = vi.fn();
      configureShadow({ onOutcome });
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      await protectShadow({ agent: "a", action: "b", context: { environment: "production" } }, { mode: "observe" });
      expect(onOutcome).toHaveBeenCalledOnce();
    });
  });

  // ── reportShadowEvent ───────────────────────────────────────────────────────

  describe("reportShadowEvent()", () => {
    function buildOutcome(overrides: Partial<Parameters<typeof reportShadowEvent>[0]> = {}): Parameters<typeof reportShadowEvent>[0] {
      return {
        decision: "permit",
        permit: { permitId: "dec_1", permitHash: "ph1", auditHash: "h1", reason: "ok", timestamp: "2026-01-01T00:00:00Z", permitExpiresAt: null },
        error: null,
        would_have_blocked: false,
        latencyMs: 42,
        evaluationId: "dec_1",
        request: { agent: "agent-x", action: "files.read", context: { environment: "production" } },
        mode: "observe",
        ...overrides,
      };
    }

    it("POSTs to /v1/shadow-events with correct payload on permit", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 })
      ) as unknown as FetchMock;
      globalThis.fetch = fetchMock;

      const outcome = buildOutcome();
      await reportShadowEvent(outcome, { apiKey: "ask_test_shadow_k1" });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/v1/shadow-events");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({ Authorization: "Bearer ask_test_shadow_k1" });

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.action).toBe("files.read");
      expect(body.agentId).toBe("agent-x");
      expect(body.decision).toBe("permit");
      expect(body.would_have_blocked).toBe(false);
      expect(body.mode).toBe("observe");
      expect(body.evaluationId).toBe("dec_1");
      expect(typeof body.timestamp).toBe("string");
    });

    it("includes deniedReason when the outcome has an error", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 })
      ) as unknown as FetchMock;
      globalThis.fetch = fetchMock;

      const deniedError = new AtlaSentDeniedError({
        decision: "deny",
        evaluationId: "dec_2",
        reason: "policy denied it",
      });

      const outcome = buildOutcome({
        decision: "deny",
        permit: null,
        error: deniedError,
        would_have_blocked: true,
        evaluationId: "dec_2",
      });

      await reportShadowEvent(outcome, { apiKey: "ask_test_shadow_k1" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.deniedReason).toBe("AtlaSent deny: policy denied it");
    });

    it("uses ATLASENT_API_KEY env var when no apiKey opt is given", async () => {
      process.env["ATLASENT_API_KEY"] = "env-key-123";
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 })
      ) as unknown as FetchMock;
      globalThis.fetch = fetchMock;

      await reportShadowEvent(buildOutcome());

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer env-key-123");
    });

    it("uses custom baseUrl when provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 })
      ) as unknown as FetchMock;
      globalThis.fetch = fetchMock;

      await reportShadowEvent(buildOutcome(), {
        apiKey: "ask_test_shadow_k1",
        baseUrl: "https://custom.example.com",
      });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://custom.example.com/v1/shadow-events");
    });

    it("throws on 5xx server errors", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response("Internal Server Error", { status: 500 })
      ) as unknown as FetchMock;

      await expect(
        reportShadowEvent(buildOutcome(), { apiKey: "ask_test_shadow_k1" }),
      ).rejects.toThrow("Shadow event reporting failed: 500");
    });

    it("does NOT throw on 4xx client errors", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response("Bad Request", { status: 400 })
      ) as unknown as FetchMock;

      // 4xx: !response.ok but status < 500 — no throw.
      await expect(
        reportShadowEvent(buildOutcome(), { apiKey: "ask_test_shadow_k1" }),
      ).resolves.toBeUndefined();
    });

    it("does NOT throw on 200 OK", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 })
      ) as unknown as FetchMock;

      await expect(
        reportShadowEvent(buildOutcome(), { apiKey: "ask_test_shadow_k1" }),
      ).resolves.toBeUndefined();
    });

    it("uses apiKey from _defaultConfig when no opts are given", async () => {
      configureShadow({ apiKey: "config-key" });
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 })
      ) as unknown as FetchMock;
      globalThis.fetch = fetchMock;

      // Override env key so we can tell which source wins.
      process.env["ATLASENT_API_KEY"] = "env-key";

      await reportShadowEvent(buildOutcome());

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      // opts.apiKey is undefined, so falls to _defaultConfig.apiKey = "config-key"
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer config-key");
    });
  });

  // ── opts override _defaultConfig ────────────────────────────────────────────

  describe("opts override _defaultConfig", () => {
    it("mode from opts takes precedence over configureShadow mode", async () => {
      configureShadow({ mode: "enforce" });
      const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
      configure({ apiKey: "ask_test_shadow_k1", fetch: fetchImpl });

      // Passing mode: "observe" in opts should override the global "enforce" mode.
      const outcome = await protectShadow(
        { agent: "a", action: "b", context: { environment: "production" } },
        { mode: "observe" },
      );
      expect(outcome.mode).toBe("observe");
      expect(outcome.would_have_blocked).toBe(true);
      // Should NOT throw (observe mode).
    });

    it("apiKey from opts takes precedence over configureShadow apiKey", async () => {
      configureShadow({ apiKey: "global-key" });
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 })
      ) as unknown as FetchMock;
      globalThis.fetch = fetchMock;

      function buildPermitOutcome() {
        return {
          decision: "permit" as const,
          permit: { permitId: "dec_1", permitHash: "ph1", auditHash: "h1", reason: "ok", timestamp: "2026-01-01T00:00:00Z", permitExpiresAt: null },
          error: null,
          would_have_blocked: false,
          latencyMs: 10,
          evaluationId: "dec_1",
          request: { agent: "a", action: "b", context: { environment: "production" } },
          mode: "observe" as const,
        };
      }

      await reportShadowEvent(buildPermitOutcome(), { apiKey: "override-key" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer override-key");
    });
  });
});
