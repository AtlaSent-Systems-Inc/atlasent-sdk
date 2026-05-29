import { describe, expect, it, vi, type MockedFunction } from "vitest";

import {
  AtlaSentError,
  VQPClient,
} from "../src/index.js";

type FetchMock = MockedFunction<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchMock {
  return vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return impl(url, init ?? {});
    },
  ) as unknown as FetchMock;
}

function makeClient(fetchImpl: FetchMock, supabaseUrl = "https://abc.supabase.co") {
  return new VQPClient({ serviceRoleKey: "service_role_key_abc", supabaseUrl, fetch: fetchImpl });
}

// ─── VQPClient constructor ────────────────────────────────────────────────────

describe("VQPClient constructor", () => {
  it("constructs successfully with valid options", () => {
    expect(
      () => new VQPClient({ serviceRoleKey: "svc_key_xyz", supabaseUrl: "https://abc.supabase.co", fetch: vi.fn() }),
    ).not.toThrow();
  });

  it("throws AtlaSentError when serviceRoleKey is empty string", () => {
    expect(
      () => new VQPClient({ serviceRoleKey: "", supabaseUrl: "https://abc.supabase.co", fetch: vi.fn() }),
    ).toThrow(AtlaSentError);
  });

  it("throws with code 'invalid_api_key' when serviceRoleKey is empty", () => {
    try {
      new VQPClient({ serviceRoleKey: "", supabaseUrl: "https://abc.supabase.co", fetch: vi.fn() });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as AtlaSentError).code).toBe("invalid_api_key");
    }
  });

  it("throws AtlaSentError when serviceRoleKey is missing", () => {
    expect(
      () => new VQPClient({ serviceRoleKey: undefined as unknown as string, supabaseUrl: "https://abc.supabase.co", fetch: vi.fn() }),
    ).toThrow(AtlaSentError);
  });

  it("rejects non-local http:// supabaseUrl", () => {
    expect(
      () =>
        new VQPClient({
          serviceRoleKey: "svc_key",
          supabaseUrl: "http://remote.supabase.co",
          fetch: vi.fn(),
        }),
    ).toThrow(AtlaSentError);
  });

  it("rejects non-local http:// with code 'network'", () => {
    try {
      new VQPClient({ serviceRoleKey: "svc_key", supabaseUrl: "http://remote.supabase.co", fetch: vi.fn() });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as AtlaSentError).code).toBe("network");
    }
  });

  it("allows http://localhost supabaseUrl", () => {
    expect(
      () =>
        new VQPClient({
          serviceRoleKey: "svc_key",
          supabaseUrl: "http://localhost:54321",
          fetch: vi.fn(),
        }),
    ).not.toThrow();
  });

  it("allows http://127.0.0.1 supabaseUrl", () => {
    expect(
      () =>
        new VQPClient({
          serviceRoleKey: "svc_key",
          supabaseUrl: "http://127.0.0.1:54321",
          fetch: vi.fn(),
        }),
    ).not.toThrow();
  });
});

// ─── VQPClient.generate ───────────────────────────────────────────────────────

const GENERATE_RESPONSE = {
  snapshot_id: "snap_abc",
  bundle_id: "bundle_123",
  bundle_version: "1.0.0",
  overall_verdict: "qualified" as const,
  quality_score: 92,
  prompt_hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  generation_model: "claude-opus-4-8",
  generated_at: "2026-05-29T02:00:00Z",
};

describe("VQPClient.generate", () => {
  it("POSTs to /functions/v1/v1-generate-vqp and returns response", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const fetchImpl = mockFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = (init as RequestInit).method ?? "";
      return jsonResponse(GENERATE_RESPONSE);
    });
    const result = await makeClient(fetchImpl).generate({ bundle_id: "b1", org_id: "org1" });
    expect(capturedUrl).toBe("https://abc.supabase.co/functions/v1/v1-generate-vqp");
    expect(capturedMethod).toBe("POST");
    expect(result.snapshot_id).toBe("snap_abc");
    expect(result.overall_verdict).toBe("qualified");
    expect(result.quality_score).toBe(92);
    expect(result.prompt_hash).toBe("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
  });

  it("sends Authorization header with Bearer service_role key", async () => {
    let authHeader = "";
    const fetchImpl = mockFetch((_url, init) => {
      authHeader = ((init as RequestInit).headers as Record<string, string>)["Authorization"] ?? "";
      return jsonResponse(GENERATE_RESPONSE);
    });
    await makeClient(fetchImpl).generate({ bundle_id: "b1", org_id: "org1" });
    expect(authHeader).toBe("Bearer service_role_key_abc");
  });

  it("sends Content-Type: application/json on POST", async () => {
    let contentType = "";
    const fetchImpl = mockFetch((_url, init) => {
      contentType = ((init as RequestInit).headers as Record<string, string>)["Content-Type"] ?? "";
      return jsonResponse(GENERATE_RESPONSE);
    });
    await makeClient(fetchImpl).generate({ bundle_id: "b1", org_id: "org1" });
    expect(contentType).toBe("application/json");
  });

  it("serializes bundle_id, org_id, and optional vqp_context in request body", async () => {
    let body = "";
    const fetchImpl = mockFetch((_url, init) => {
      body = (init as RequestInit).body as string;
      return jsonResponse(GENERATE_RESPONSE);
    });
    await makeClient(fetchImpl).generate({
      bundle_id: "b1",
      org_id: "org1",
      vqp_context: { env: "prod", reviewer: "alice" },
    });
    const parsed = JSON.parse(body);
    expect(parsed.bundle_id).toBe("b1");
    expect(parsed.org_id).toBe("org1");
    expect(parsed.vqp_context).toEqual({ env: "prod", reviewer: "alice" });
  });

  it("omits vqp_context when not provided", async () => {
    let body = "";
    const fetchImpl = mockFetch((_url, init) => {
      body = (init as RequestInit).body as string;
      return jsonResponse(GENERATE_RESPONSE);
    });
    await makeClient(fetchImpl).generate({ bundle_id: "b1", org_id: "org1" });
    const parsed = JSON.parse(body);
    expect(parsed.vqp_context).toBeUndefined();
  });
});

// ─── VQPClient.verify ─────────────────────────────────────────────────────────

const VERIFY_RESPONSE = {
  snapshot_id: "snap_abc",
  hash_match: true,
  original_prompt_hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  rerun_prompt_hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  rerun_score: null,
  rerun_verdict: null,
  score_delta: null,
  verdict_changed: false,
  audit_log_id: "alog_xyz",
};

describe("VQPClient.verify", () => {
  it("POSTs to /functions/v1/v1-verify-vqp and returns response", async () => {
    let capturedUrl = "";
    const fetchImpl = mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse(VERIFY_RESPONSE);
    });
    const result = await makeClient(fetchImpl).verify({ snapshot_id: "snap_abc" });
    expect(capturedUrl).toBe("https://abc.supabase.co/functions/v1/v1-verify-vqp");
    expect(result.snapshot_id).toBe("snap_abc");
    expect(result.hash_match).toBe(true);
    expect(result.verdict_changed).toBe(false);
    expect(result.audit_log_id).toBe("alog_xyz");
  });

  it("sends rerun: true in body when requested", async () => {
    let body = "";
    const fetchImpl = mockFetch((_url, init) => {
      body = (init as RequestInit).body as string;
      return jsonResponse({ ...VERIFY_RESPONSE, rerun_score: 88, rerun_verdict: "qualified", score_delta: -4 });
    });
    await makeClient(fetchImpl).verify({ snapshot_id: "snap_abc", rerun: true });
    const parsed = JSON.parse(body);
    expect(parsed.snapshot_id).toBe("snap_abc");
    expect(parsed.rerun).toBe(true);
  });

  it("returns score_delta and rerun_verdict when rerun was performed", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        ...VERIFY_RESPONSE,
        rerun_score: 88,
        rerun_verdict: "qualified",
        score_delta: -4,
      }),
    );
    const result = await makeClient(fetchImpl).verify({ snapshot_id: "snap_abc", rerun: true });
    expect(result.rerun_score).toBe(88);
    expect(result.rerun_verdict).toBe("qualified");
    expect(result.score_delta).toBe(-4);
  });

  it("reports verdict_changed: true when verdict drifted", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        ...VERIFY_RESPONSE,
        rerun_score: 55,
        rerun_verdict: "not_qualified",
        score_delta: -37,
        verdict_changed: true,
      }),
    );
    const result = await makeClient(fetchImpl).verify({ snapshot_id: "snap_abc", rerun: true });
    expect(result.verdict_changed).toBe(true);
    expect(result.rerun_verdict).toBe("not_qualified");
  });

  it("hash_match: false indicates prompt tampering", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        ...VERIFY_RESPONSE,
        hash_match: false,
        rerun_prompt_hash: "0000000000000000000000000000000000000000000000000000000000000000",
      }),
    );
    const result = await makeClient(fetchImpl).verify({ snapshot_id: "snap_abc" });
    expect(result.hash_match).toBe(false);
  });
});

// ─── HTTP error handling ──────────────────────────────────────────────────────

describe("VQPClient HTTP error handling", () => {
  const errorCases: Array<[number, string]> = [
    [401, "invalid_api_key"],
    [403, "forbidden"],
    [404, "network"],
    [409, "network"],
    [429, "rate_limited"],
    [500, "server_error"],
    [503, "server_error"],
  ];

  for (const [status, expectedCode] of errorCases) {
    it(`maps HTTP ${status} to AtlaSentError code "${expectedCode}"`, async () => {
      const fetchImpl = mockFetch(() =>
        jsonResponse({ message: `HTTP ${status}` }, status),
      );
      const client = makeClient(fetchImpl);
      await expect(client.generate({ bundle_id: "b1", org_id: "org1" })).rejects.toMatchObject({
        code: expectedCode,
      });
    });
  }

  it("uses message from JSON error body when available", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ message: "service_role key is invalid" }, 401),
    );
    await expect(makeClient(fetchImpl).generate({ bundle_id: "b1", org_id: "org1" })).rejects.toThrow(
      "service_role key is invalid",
    );
  });

  it("falls back to generic message when error body has no message", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ code: "unknown" }, 500),
    );
    await expect(makeClient(fetchImpl).generate({ bundle_id: "b1", org_id: "org1" })).rejects.toThrow(
      /status 500/,
    );
  });

  it("throws AtlaSentError on non-JSON response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    ) as unknown as FetchMock;
    await expect(makeClient(fetchImpl).generate({ bundle_id: "b1", org_id: "org1" })).rejects.toMatchObject({
      code: "network",
    });
  });

  it("throws AtlaSentError when fetch rejects (network error)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchMock;
    await expect(makeClient(fetchImpl).generate({ bundle_id: "b1", org_id: "org1" })).rejects.toMatchObject({
      code: "network",
    });
  });

  it("includes path in network error message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchMock;
    await expect(makeClient(fetchImpl).generate({ bundle_id: "b1", org_id: "org1" })).rejects.toThrow(
      /\/functions\/v1\/v1-generate-vqp/,
    );
  });
});
