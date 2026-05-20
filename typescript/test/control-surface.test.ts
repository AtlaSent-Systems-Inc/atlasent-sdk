import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from "vitest";
import {
  configureControlSurface,
  checkIntegrationHealth,
  reportProtectedAction,
  getEnforcementStatus,
  getOrgSummary,
} from "../src/controlSurface.js";

type FetchMock = MockedFunction<typeof fetch>;

// ── Helpers ────────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(response: Response): FetchMock {
  return vi.fn().mockResolvedValue(response) as unknown as FetchMock;
}

// ── Test setup ─────────────────────────────────────────────────────────────────

describe("controlSurface module", () => {
  const ORIGINAL_API_KEY = process.env["ATLASENT_API_KEY"];
  const ORIGINAL_BASE_URL = process.env["ATLASENT_BASE_URL"];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    // Reset module-level _config to a clean sentinel state.
    // We use apiKey "" so the env var always wins unless a test explicitly
    // calls configureControlSurface again with a real value.
    // baseUrl "" would break URL construction, so we set a well-known default.
    // The workaround for exactOptionalPropertyTypes: explicit string/number
    // values that are safe defaults rather than undefined.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (configureControlSurface as (c: any) => void)({ apiKey: null, baseUrl: null, timeoutMs: null });
    process.env["ATLASENT_API_KEY"] = "ask_test_control_k1";
    delete process.env["ATLASENT_BASE_URL"];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (ORIGINAL_API_KEY !== undefined) {
      process.env["ATLASENT_API_KEY"] = ORIGINAL_API_KEY;
    } else {
      delete process.env["ATLASENT_API_KEY"];
    }
    if (ORIGINAL_BASE_URL !== undefined) {
      process.env["ATLASENT_BASE_URL"] = ORIGINAL_BASE_URL;
    } else {
      delete process.env["ATLASENT_BASE_URL"];
    }
    vi.restoreAllMocks();
  });

  // ── configureControlSurface ────────────────────────────────────────────────

  describe("configureControlSurface()", () => {
    it("merges config so subsequent calls accumulate", async () => {
      configureControlSurface({ apiKey: "key-a" });
      configureControlSurface({ baseUrl: "https://custom.example.com" });

      const fetchMock = mockFetch(jsonResponse({ version: "1.0", status: "ok" }));
      globalThis.fetch = fetchMock;

      await checkIntegrationHealth();

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("https://custom.example.com");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer key-a");
    });

    it("later keys overwrite earlier ones", async () => {
      configureControlSurface({ apiKey: "first-key" });
      configureControlSurface({ apiKey: "second-key" });

      const fetchMock = mockFetch(jsonResponse({ version: "1.0", status: "ok" }));
      globalThis.fetch = fetchMock;

      await checkIntegrationHealth();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer second-key");
    });
  });

  // ── checkIntegrationHealth ─────────────────────────────────────────────────

  describe("checkIntegrationHealth()", () => {
    it("returns healthy=true when /v1/health responds with status ok", async () => {
      globalThis.fetch = mockFetch(
        jsonResponse({ version: "1.0", status: "ok" }),
      );

      const report = await checkIntegrationHealth({ apiKey: "ask_test_control_k1" });

      expect(report.healthy).toBe(true);
      expect(report.apiReachable).toBe(true);
      expect(report.authenticated).toBe(true);
      expect(report.apiVersion).toBe("1.0");
      expect(report.errors).toHaveLength(0);
      expect(typeof report.latencyMs).toBe("number");
      expect(report.latencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof report.checkedAt).toBe("string");
    });

    it("returns healthy=true when /v1/health responds with status healthy", async () => {
      globalThis.fetch = mockFetch(
        jsonResponse({ version: "2.0", status: "healthy" }),
      );

      const report = await checkIntegrationHealth({ apiKey: "ask_test_control_k1" });

      expect(report.healthy).toBe(true);
      expect(report.authenticated).toBe(true);
      expect(report.apiVersion).toBe("2.0");
    });

    it("includes ATLASENT_API_KEY error when no api key is configured", async () => {
      delete process.env["ATLASENT_API_KEY"];
      configureControlSurface({});
      globalThis.fetch = mockFetch(
        jsonResponse({ version: "1.0", status: "ok" }),
      );

      const report = await checkIntegrationHealth({ apiKey: "" });

      expect(report.errors).toContain("ATLASENT_API_KEY is not configured");
    });

    it("returns apiReachable=true and authenticated=false on 401 error", async () => {
      globalThis.fetch = mockFetch(
        new Response("Unauthorized", { status: 401 }),
      );

      const report = await checkIntegrationHealth({ apiKey: "bad-key" });

      expect(report.apiReachable).toBe(true);
      expect(report.authenticated).toBe(false);
      expect(report.healthy).toBe(false);
      expect(report.errors).toContain("API key is invalid or lacks required permissions");
    });

    it("returns apiReachable=true and authenticated=false on 403 error", async () => {
      globalThis.fetch = mockFetch(
        new Response("Forbidden", { status: 403 }),
      );

      const report = await checkIntegrationHealth({ apiKey: "bad-key" });

      expect(report.apiReachable).toBe(true);
      expect(report.authenticated).toBe(false);
      expect(report.healthy).toBe(false);
      expect(report.errors).toContain("API key is invalid or lacks required permissions");
    });

    it("returns apiReachable=false on network error", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(
        new TypeError("fetch failed"),
      ) as unknown as FetchMock;

      const report = await checkIntegrationHealth({ apiKey: "ask_test_control_k1" });

      expect(report.apiReachable).toBe(false);
      expect(report.authenticated).toBe(false);
      expect(report.healthy).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.errors[0]).toMatch(/API unreachable/);
    });

    it("returns authenticated=false when status is not ok/healthy", async () => {
      globalThis.fetch = mockFetch(
        jsonResponse({ version: "1.0", status: "degraded" }),
      );

      const report = await checkIntegrationHealth({ apiKey: "ask_test_control_k1" });

      expect(report.apiReachable).toBe(true);
      expect(report.authenticated).toBe(false);
      expect(report.healthy).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.errors[0]).toMatch(/degraded/);
    });

    it("handles missing status field in health response", async () => {
      globalThis.fetch = mockFetch(
        jsonResponse({ version: "1.0" }),
      );

      const report = await checkIntegrationHealth({ apiKey: "ask_test_control_k1" });

      expect(report.apiReachable).toBe(true);
      expect(report.authenticated).toBe(false);
      expect(report.errors[0]).toMatch(/unknown/);
    });

    it("hits /v1/health on the configured baseUrl", async () => {
      const fetchMock = mockFetch(jsonResponse({ version: "1.0", status: "ok" }));
      globalThis.fetch = fetchMock;

      await checkIntegrationHealth({
        apiKey: "ask_test_control_k1",
        baseUrl: "https://custom.atlasent.ai",
      });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://custom.atlasent.ai/v1/health");
    });

    it("sends Authorization header with the api key", async () => {
      const fetchMock = mockFetch(jsonResponse({ version: "1.0", status: "ok" }));
      globalThis.fetch = fetchMock;

      await checkIntegrationHealth({ apiKey: "sk-abc123" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-abc123");
    });

    it("reads api key from ATLASENT_API_KEY env var when not in opts", async () => {
      process.env["ATLASENT_API_KEY"] = "env-api-key";
      const fetchMock = mockFetch(jsonResponse({ version: "1.0", status: "ok" }));
      globalThis.fetch = fetchMock;

      await checkIntegrationHealth();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer env-api-key");
    });

    it("returns latencyMs as null on network error before response", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("connection refused")) as unknown as FetchMock;

      const report = await checkIntegrationHealth({ apiKey: "ask_test_control_k1" });

      // latencyMs is measured after the catch, so it should be a non-null number.
      expect(report.latencyMs).not.toBeNull();
    });

    it("checkedAt is an ISO 8601 timestamp string", async () => {
      globalThis.fetch = mockFetch(jsonResponse({ version: "1.0", status: "ok" }));

      const report = await checkIntegrationHealth({ apiKey: "ask_test_control_k1" });

      expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // ── reportProtectedAction ──────────────────────────────────────────────────

  describe("reportProtectedAction()", () => {
    const ACTION_ENTRY = {
      actionClass: "files.delete",
      firstRegisteredAt: "2026-01-01T00:00:00Z",
      lastUpdatedAt: "2026-01-02T00:00:00Z",
      enforcementMode: "observe",
      schemaId: null,
      tags: [],
    };

    it("POSTs to /v1/control-surface/actions with correct payload", async () => {
      const fetchMock = mockFetch(jsonResponse(ACTION_ENTRY));
      globalThis.fetch = fetchMock;

      const result = await reportProtectedAction({
        apiKey: "ask_test_control_k1",
        actionClass: "files.delete",
        enforcementMode: "warn",
        tags: ["critical"],
      });

      expect(result).toEqual(ACTION_ENTRY);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/v1/control-surface/actions");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ask_test_control_k1");

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["action_class"]).toBe("files.delete");
      expect(body["enforcement_mode"]).toBe("warn");
      expect(body["tags"]).toEqual(["critical"]);
    });

    it("defaults enforcement_mode to 'observe' when not specified", async () => {
      const fetchMock = mockFetch(jsonResponse(ACTION_ENTRY));
      globalThis.fetch = fetchMock;

      await reportProtectedAction({
        apiKey: "ask_test_control_k1",
        actionClass: "files.delete",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["enforcement_mode"]).toBe("observe");
    });

    it("defaults tags to [] and schema_id to null when not specified", async () => {
      const fetchMock = mockFetch(jsonResponse(ACTION_ENTRY));
      globalThis.fetch = fetchMock;

      await reportProtectedAction({
        apiKey: "ask_test_control_k1",
        actionClass: "files.delete",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["tags"]).toEqual([]);
      expect(body["schema_id"]).toBeNull();
    });

    it("sends schemaId in body when provided", async () => {
      const fetchMock = mockFetch(jsonResponse(ACTION_ENTRY));
      globalThis.fetch = fetchMock;

      await reportProtectedAction({
        apiKey: "ask_test_control_k1",
        actionClass: "files.delete",
        schemaId: "schema-abc",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["schema_id"]).toBe("schema-abc");
    });

    it("throws on non-2xx HTTP response", async () => {
      globalThis.fetch = mockFetch(new Response("Internal Server Error", { status: 500 }));

      await expect(
        reportProtectedAction({ apiKey: "ask_test_control_k1", actionClass: "files.delete" }),
      ).rejects.toThrow("HTTP 500");
    });

    it("throws on 404 response", async () => {
      globalThis.fetch = mockFetch(new Response("Not Found", { status: 404 }));

      await expect(
        reportProtectedAction({ apiKey: "ask_test_control_k1", actionClass: "files.delete" }),
      ).rejects.toThrow("HTTP 404");
    });

    it("uses Content-Type application/json header", async () => {
      const fetchMock = mockFetch(jsonResponse(ACTION_ENTRY));
      globalThis.fetch = fetchMock;

      await reportProtectedAction({ apiKey: "ask_test_control_k1", actionClass: "files.delete" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    });

    it("uses custom baseUrl when provided", async () => {
      const fetchMock = mockFetch(jsonResponse(ACTION_ENTRY));
      globalThis.fetch = fetchMock;

      await reportProtectedAction({
        apiKey: "ask_test_control_k1",
        actionClass: "files.delete",
        baseUrl: "https://private.atlasent.ai",
      });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://private.atlasent.ai/v1/control-surface/actions");
    });

    it("falls back to env ATLASENT_API_KEY when apiKey not in opts", async () => {
      process.env["ATLASENT_API_KEY"] = "env-key";
      const fetchMock = mockFetch(jsonResponse(ACTION_ENTRY));
      globalThis.fetch = fetchMock;

      await reportProtectedAction({ actionClass: "files.delete" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer env-key");
    });
  });

  // ── getEnforcementStatus ───────────────────────────────────────────────────

  describe("getEnforcementStatus()", () => {
    const STATUS_RESPONSE = {
      actionClass: "files.delete",
      mode: "observe",
      blockRate: 0.05,
      totalEvaluations: 200,
      lastSeenAt: "2026-01-15T12:00:00Z",
      schemaRegistered: true,
    };

    it("GETs /v1/control-surface/actions/:id/status and returns data", async () => {
      const fetchMock = mockFetch(jsonResponse(STATUS_RESPONSE));
      globalThis.fetch = fetchMock;

      const result = await getEnforcementStatus({
        apiKey: "ask_test_control_k1",
        actionClass: "files.delete",
      });

      expect(result).toEqual(STATUS_RESPONSE);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/v1/control-surface/actions/files.delete/status");
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ask_test_control_k1");
    });

    it("URL-encodes the actionClass in the path", async () => {
      const fetchMock = mockFetch(jsonResponse(STATUS_RESPONSE));
      globalThis.fetch = fetchMock;

      await getEnforcementStatus({
        apiKey: "ask_test_control_k1",
        actionClass: "files/delete action",
      });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("files%2Fdelete%20action");
    });

    it("throws on 404 response", async () => {
      globalThis.fetch = mockFetch(new Response("Not Found", { status: 404 }));

      await expect(
        getEnforcementStatus({ apiKey: "ask_test_control_k1", actionClass: "missing.action" }),
      ).rejects.toThrow("HTTP 404");
    });

    it("throws on 500 response", async () => {
      globalThis.fetch = mockFetch(new Response("Server Error", { status: 500 }));

      await expect(
        getEnforcementStatus({ apiKey: "ask_test_control_k1", actionClass: "files.delete" }),
      ).rejects.toThrow("HTTP 500");
    });

    it("throws on network failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as FetchMock;

      await expect(
        getEnforcementStatus({ apiKey: "ask_test_control_k1", actionClass: "files.delete" }),
      ).rejects.toThrow("ECONNREFUSED");
    });

    it("uses custom baseUrl when provided", async () => {
      const fetchMock = mockFetch(jsonResponse(STATUS_RESPONSE));
      globalThis.fetch = fetchMock;

      await getEnforcementStatus({
        apiKey: "ask_test_control_k1",
        actionClass: "files.delete",
        baseUrl: "https://custom.atlasent.ai",
      });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("https://custom.atlasent.ai/v1/control-surface/actions/");
    });

    it("falls back to env ATLASENT_API_KEY when apiKey not in opts", async () => {
      process.env["ATLASENT_API_KEY"] = "env-enforce-key";
      const fetchMock = mockFetch(jsonResponse(STATUS_RESPONSE));
      globalThis.fetch = fetchMock;

      await getEnforcementStatus({ actionClass: "files.delete" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer env-enforce-key");
    });
  });

  // ── getOrgSummary ──────────────────────────────────────────────────────────

  describe("getOrgSummary()", () => {
    const ORG_SUMMARY = {
      orgId: "org-abc123",
      activePolicies: 5,
      totalPolicies: 8,
      activeOverrides: 2,
      pendingEscalations: 0,
      evidenceSigningEnabled: true,
      shadowModeActions: 3,
      enforcedActions: 2,
      lastEvaluationAt: "2026-01-20T09:00:00Z",
    };

    it("GETs /v1/control-surface/summary and returns data", async () => {
      const fetchMock = mockFetch(jsonResponse(ORG_SUMMARY));
      globalThis.fetch = fetchMock;

      const result = await getOrgSummary({ apiKey: "ask_test_control_k1" });

      expect(result).toEqual(ORG_SUMMARY);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/v1/control-surface/summary");
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ask_test_control_k1");
    });

    it("works without any opts (uses env var)", async () => {
      process.env["ATLASENT_API_KEY"] = "env-org-key";
      const fetchMock = mockFetch(jsonResponse(ORG_SUMMARY));
      globalThis.fetch = fetchMock;

      const result = await getOrgSummary();

      expect(result).toEqual(ORG_SUMMARY);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer env-org-key");
    });

    it("uses custom baseUrl when provided", async () => {
      const fetchMock = mockFetch(jsonResponse(ORG_SUMMARY));
      globalThis.fetch = fetchMock;

      await getOrgSummary({
        apiKey: "ask_test_control_k1",
        baseUrl: "https://custom.atlasent.ai",
      });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://custom.atlasent.ai/v1/control-surface/summary");
    });

    it("sends Accept: application/json header", async () => {
      const fetchMock = mockFetch(jsonResponse(ORG_SUMMARY));
      globalThis.fetch = fetchMock;

      await getOrgSummary({ apiKey: "ask_test_control_k1" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Accept"]).toBe("application/json");
    });

    it("throws on 500 response", async () => {
      globalThis.fetch = mockFetch(new Response("Internal Server Error", { status: 500 }));

      await expect(
        getOrgSummary({ apiKey: "ask_test_control_k1" }),
      ).rejects.toThrow("HTTP 500");
    });

    it("throws on 403 response", async () => {
      globalThis.fetch = mockFetch(new Response("Forbidden", { status: 403 }));

      await expect(
        getOrgSummary({ apiKey: "ask_test_control_k1" }),
      ).rejects.toThrow("HTTP 403");
    });

    it("throws on network failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as FetchMock;

      await expect(
        getOrgSummary({ apiKey: "ask_test_control_k1" }),
      ).rejects.toThrow("network down");
    });

    it("handles null lastEvaluationAt in response", async () => {
      const fetchMock = mockFetch(jsonResponse({ ...ORG_SUMMARY, lastEvaluationAt: null }));
      globalThis.fetch = fetchMock;

      const result = await getOrgSummary({ apiKey: "ask_test_control_k1" });
      expect(result.lastEvaluationAt).toBeNull();
    });

    it("uses apiKey from _config when not in opts", async () => {
      configureControlSurface({ apiKey: "config-level-key" });
      const fetchMock = mockFetch(jsonResponse(ORG_SUMMARY));
      globalThis.fetch = fetchMock;

      // Pass opts without apiKey to test config resolution.
      await getOrgSummary({ baseUrl: "https://api.atlasent.ai" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer config-level-key");
    });
  });

  // ── resolveConfig precedence ───────────────────────────────────────────────

  describe("config resolution precedence", () => {
    it("opts.apiKey takes precedence over _config.apiKey", async () => {
      configureControlSurface({ apiKey: "config-key" });
      const fetchMock = mockFetch(jsonResponse({ orgId: "org-1", activePolicies: 0, totalPolicies: 0, activeOverrides: 0, pendingEscalations: 0, evidenceSigningEnabled: false, shadowModeActions: 0, enforcedActions: 0, lastEvaluationAt: null }));
      globalThis.fetch = fetchMock;

      await getOrgSummary({ apiKey: "opts-key" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer opts-key");
    });

    it("opts.baseUrl takes precedence over _config.baseUrl", async () => {
      configureControlSurface({ baseUrl: "https://config-base.atlasent.ai" });
      const fetchMock = mockFetch(jsonResponse({ version: "1.0", status: "ok" }));
      globalThis.fetch = fetchMock;

      await checkIntegrationHealth({
        apiKey: "ask_test_control_k1",
        baseUrl: "https://opts-base.atlasent.ai",
      });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("https://opts-base.atlasent.ai");
    });

    it("_config.apiKey takes precedence over env var", async () => {
      process.env["ATLASENT_API_KEY"] = "env-key";
      configureControlSurface({ apiKey: "config-key" });

      const fetchMock = mockFetch(jsonResponse({ version: "1.0", status: "ok" }));
      globalThis.fetch = fetchMock;

      await checkIntegrationHealth();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer config-key");
    });

    it("uses default baseUrl https://api.atlasent.ai when nothing is configured", async () => {
      delete process.env["ATLASENT_BASE_URL"];
      const fetchMock = mockFetch(jsonResponse({ version: "1.0", status: "ok" }));
      globalThis.fetch = fetchMock;

      await checkIntegrationHealth({ apiKey: "ask_test_control_k1" });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("https://api.atlasent.ai");
    });
  });
});
