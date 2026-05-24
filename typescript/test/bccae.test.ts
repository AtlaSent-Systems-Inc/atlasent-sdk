import { describe, expect, it, vi, type MockedFunction } from "vitest";

import {
  AtlaSentError,
  BCCAEClient,
  generateBccaeNonce,
  type BccaeEvaluateInput,
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

function makeClient(fetchImpl: FetchMock, baseUrl = "https://api.atlasent.io") {
  return new BCCAEClient({ apiKey: "bk_test_abc", baseUrl, fetch: fetchImpl });
}

// ─── generateBccaeNonce ───────────────────────────────────────────────────────

describe("generateBccaeNonce", () => {
  it("returns a 64-character string", () => {
    expect(generateBccaeNonce()).toHaveLength(64);
  });

  it("returns only lowercase hex characters", () => {
    expect(generateBccaeNonce()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates different values on successive calls", () => {
    expect(generateBccaeNonce()).not.toBe(generateBccaeNonce());
  });
});

// ─── BCCAEClient constructor ──────────────────────────────────────────────────

describe("BCCAEClient constructor", () => {
  it("constructs successfully with a valid api key", () => {
    expect(
      () => new BCCAEClient({ apiKey: "bk_test", fetch: vi.fn() }),
    ).not.toThrow();
  });

  it("throws AtlaSentError when apiKey is empty string", () => {
    expect(
      () => new BCCAEClient({ apiKey: "", fetch: vi.fn() }),
    ).toThrow(AtlaSentError);
  });

  it("throws AtlaSentError when apiKey is missing", () => {
    expect(
      () => new BCCAEClient({ apiKey: undefined as unknown as string, fetch: vi.fn() }),
    ).toThrow(AtlaSentError);
  });

  it("rejects non-local http:// base URLs", () => {
    expect(
      () =>
        new BCCAEClient({
          apiKey: "bk_test",
          baseUrl: "http://remote.example.com",
          fetch: vi.fn(),
        }),
    ).toThrow(AtlaSentError);
  });

  it("allows http://localhost base URLs", () => {
    expect(
      () =>
        new BCCAEClient({
          apiKey: "bk_test",
          baseUrl: "http://localhost:3000",
          fetch: vi.fn(),
        }),
    ).not.toThrow();
  });

  it("allows http://127.0.0.1 base URLs", () => {
    expect(
      () =>
        new BCCAEClient({
          apiKey: "bk_test",
          baseUrl: "http://127.0.0.1:9000",
          fetch: vi.fn(),
        }),
    ).not.toThrow();
  });

  it("strips trailing slashes from baseUrl", async () => {
    let capturedUrl = "";
    const fetchImpl = mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse({ evaluation_id: "e1", envelope_hash: "h", permit_token: "t", permit_id: "p", expires_at: "2026-06-01T00:00:00Z", outcome: "PERMIT" });
    });
    const client = new BCCAEClient({ apiKey: "bk_test", baseUrl: "https://api.atlasent.io///", fetch: fetchImpl });
    await client.evaluate(minimalEvaluateInput());
    expect(capturedUrl).toBe("https://api.atlasent.io/v1/bccae/evaluations");
  });
});

// ─── evaluate ─────────────────────────────────────────────────────────────────

function minimalEvaluateInput(): BccaeEvaluateInput {
  return {
    actor_id: "agent-1",
    actor_type: "AGENT",
    actor_trust_level: "L2",
    action_id: "production.deploy",
    execution_intent: "deploy commit abc123 to prod",
    caller_nonce: generateBccaeNonce(),
    resource_ref: "service/api",
    resource_type: "SERVICE",
    resource_classification: "CONFIDENTIAL",
    deployment_env: "PROD",
    deployment_region: "us-east-1",
    security_posture: "STANDARD",
  };
}

const EVALUATE_RESPONSE = {
  evaluation_id: "eval_abc",
  envelope_hash: "deadbeef01",
  permit_token: "bce.v1.abc.sig",
  permit_id: "permit_xyz",
  expires_at: "2026-05-24T02:00:00Z",
  outcome: "PERMIT" as const,
};

describe("BCCAEClient.evaluate", () => {
  it("POSTs to /v1/bccae/evaluations and returns response", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const fetchImpl = mockFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = (init as RequestInit).method ?? "";
      return jsonResponse(EVALUATE_RESPONSE);
    });
    const client = makeClient(fetchImpl);
    const result = await client.evaluate(minimalEvaluateInput());
    expect(capturedUrl).toBe("https://api.atlasent.io/v1/bccae/evaluations");
    expect(capturedMethod).toBe("POST");
    expect(result.evaluation_id).toBe("eval_abc");
    expect(result.permit_token).toBe("bce.v1.abc.sig");
    expect(result.outcome).toBe("PERMIT");
  });

  it("sends Authorization header with Bearer token", async () => {
    let authHeader = "";
    const fetchImpl = mockFetch((_url, init) => {
      authHeader = ((init as RequestInit).headers as Record<string, string>)["Authorization"] ?? "";
      return jsonResponse(EVALUATE_RESPONSE);
    });
    await makeClient(fetchImpl).evaluate(minimalEvaluateInput());
    expect(authHeader).toBe("Bearer bk_test_abc");
  });

  it("sends Content-Type: application/json on POST", async () => {
    let contentType = "";
    const fetchImpl = mockFetch((_url, init) => {
      contentType = ((init as RequestInit).headers as Record<string, string>)["Content-Type"] ?? "";
      return jsonResponse(EVALUATE_RESPONSE);
    });
    await makeClient(fetchImpl).evaluate(minimalEvaluateInput());
    expect(contentType).toBe("application/json");
  });

  it("serializes optional fields when provided", async () => {
    let body = "";
    const fetchImpl = mockFetch((_url, init) => {
      body = (init as RequestInit).body as string;
      return jsonResponse(EVALUATE_RESPONSE);
    });
    const input = {
      ...minimalEvaluateInput(),
      actor_claims: { role: "deployer" },
      organization_version: 42,
      request_source: "API" as const,
      request_chain_id: "chain-1",
      parent_eval_id: "parent-eval-1",
      external_signals: [{ type: "scan", result: "clean" }],
      dependencies: [{ id: "dep-1" }],
      policy_version_set: [{ policy: "v1" }],
    };
    await makeClient(fetchImpl).evaluate(input);
    const parsed = JSON.parse(body);
    expect(parsed.actor_claims).toEqual({ role: "deployer" });
    expect(parsed.organization_version).toBe(42);
    expect(parsed.request_source).toBe("API");
    expect(parsed.request_chain_id).toBe("chain-1");
    expect(parsed.parent_eval_id).toBe("parent-eval-1");
  });
});

// ─── execute ──────────────────────────────────────────────────────────────────

describe("BCCAEClient.execute", () => {
  it("POSTs to /v1/bccae/execute and returns authorized result", async () => {
    const executeResponse = {
      authorized: true,
      outcome: "EXECUTION_AUTHORIZED",
      permit_id: "permit_xyz",
      evaluation_id: "eval_abc",
      envelope_hash: "deadbeef01",
      evidence_id: "ev_1",
    };
    const fetchImpl = mockFetch((url) => {
      expect(url).toBe("https://api.atlasent.io/v1/bccae/execute");
      return jsonResponse(executeResponse);
    });
    const result = await makeClient(fetchImpl).execute({
      permit_token: "bce.v1.abc.sig",
      action_id: "production.deploy",
      resource_ref: "service/api",
    });
    expect(result.authorized).toBe(true);
    expect(result.outcome).toBe("EXECUTION_AUTHORIZED");
  });

  it("returns denial as a value — does not throw", async () => {
    const denialResponse = {
      authorized: false,
      outcome: "EXECUTION_DENIED",
      check: "EXPIRY",
      reason: "permit has expired",
    };
    const fetchImpl = mockFetch(() => jsonResponse(denialResponse));
    const result = await makeClient(fetchImpl).execute({
      permit_token: "bce.v1.abc.sig",
      action_id: "production.deploy",
      resource_ref: "service/api",
    });
    expect(result.authorized).toBe(false);
    expect(result.check).toBe("EXPIRY");
    expect(result.reason).toBe("permit has expired");
  });
});

// ─── revoke ───────────────────────────────────────────────────────────────────

describe("BCCAEClient.revoke", () => {
  it("POSTs to /v1/bccae/revocations and returns revocation record", async () => {
    const revokeResponse = {
      revocation_id: "rev_1",
      target_type: "PERMIT",
      target_id: "permit_xyz",
      effective_at: "2026-05-24T01:45:00Z",
    };
    const fetchImpl = mockFetch((url) => {
      expect(url).toBe("https://api.atlasent.io/v1/bccae/revocations");
      return jsonResponse(revokeResponse);
    });
    const result = await makeClient(fetchImpl).revoke({
      target_type: "PERMIT",
      target_id: "permit_xyz",
      reason: "operator override",
    });
    expect(result.revocation_id).toBe("rev_1");
    expect(result.target_type).toBe("PERMIT");
  });
});

// ─── getEvidence ──────────────────────────────────────────────────────────────

const EVIDENCE_RESPONSE = {
  evidence_id: "ev_1",
  org_id: "org_1",
  event_type: "EVALUATION_COMPLETE",
  evaluation_id: "eval_abc",
  permit_id: null,
  envelope_hash: "deadbeef01",
  actor_id: "agent-1",
  action_id: "production.deploy",
  resource_ref: "service/api",
  outcome: "PERMIT",
  detail: {},
  previous_evidence_id: null,
  previous_hash: null,
  record_hash: "abc123",
  sequence: 1,
  recorded_at: "2026-05-24T01:00:00Z",
  chain_integrity: { hash_intact: true },
};

describe("BCCAEClient.getEvidence", () => {
  it("GETs /v1/bccae/evidence/:id and returns the record", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const fetchImpl = mockFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = (init as RequestInit).method ?? "GET";
      return jsonResponse(EVIDENCE_RESPONSE);
    });
    const result = await makeClient(fetchImpl).getEvidence("ev_1");
    expect(capturedUrl).toBe("https://api.atlasent.io/v1/bccae/evidence/ev_1");
    expect(capturedMethod).toBe("GET");
    expect(result.evidence_id).toBe("ev_1");
    expect(result.chain_integrity.hash_intact).toBe(true);
  });

  it("URL-encodes the evidence ID", async () => {
    let capturedUrl = "";
    const fetchImpl = mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse(EVIDENCE_RESPONSE);
    });
    await makeClient(fetchImpl).getEvidence("ev/special id");
    expect(capturedUrl).toContain(encodeURIComponent("ev/special id"));
  });

  it("throws AtlaSentError when evidenceId is empty", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVIDENCE_RESPONSE));
    await expect(makeClient(fetchImpl).getEvidence("")).rejects.toThrow(AtlaSentError);
  });
});

// ─── HTTP error handling ──────────────────────────────────────────────────────

describe("BCCAEClient HTTP error handling", () => {
  const errorCases: Array<[number, string]> = [
    [401, "unauthorized"],
    [403, "permission_denied"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "rate_limited"],
    [500, "network"],
    [503, "network"],
  ];

  for (const [status, expectedCode] of errorCases) {
    it(`maps HTTP ${status} to AtlaSentError code "${expectedCode}"`, async () => {
      const fetchImpl = mockFetch(() =>
        jsonResponse({ message: `HTTP ${status}` }, status),
      );
      const client = makeClient(fetchImpl);
      await expect(client.evaluate(minimalEvaluateInput())).rejects.toMatchObject({
        code: expectedCode,
      });
    });
  }

  it("uses message from JSON error body when available", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ message: "custom error message" }, 403),
    );
    await expect(makeClient(fetchImpl).evaluate(minimalEvaluateInput())).rejects.toThrow(
      "custom error message",
    );
  });

  it("falls back to generic message when error body has no message", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ code: "unknown" }, 500),
    );
    await expect(makeClient(fetchImpl).evaluate(minimalEvaluateInput())).rejects.toThrow(
      /status 500/,
    );
  });

  it("throws AtlaSentError on non-JSON response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    ) as unknown as FetchMock;
    await expect(makeClient(fetchImpl).evaluate(minimalEvaluateInput())).rejects.toMatchObject({
      code: "network",
    });
  });

  it("throws AtlaSentError when fetch rejects (network error)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchMock;
    await expect(makeClient(fetchImpl).evaluate(minimalEvaluateInput())).rejects.toMatchObject({
      code: "network",
    });
  });

  it("includes path in network error message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchMock;
    await expect(makeClient(fetchImpl).evaluate(minimalEvaluateInput())).rejects.toThrow(
      /\/v1\/bccae\/evaluations/,
    );
  });
});
