// Tests for AtlaSentClient.submitAssertion() — F06 External Signal Ingestion.
//
// Covers: success (new assertion), success (reused idempotent assertion),
// client-side validation errors, server 4xx error handling, and malformed
// server response detection.

import { describe, expect, it, vi, type MockedFunction } from "vitest";
import { AtlaSentClient, AtlaSentError } from "../src/index.js";

type FetchMock = MockedFunction<typeof fetch>;

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
  return vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return impl(url, init ?? {});
    },
  ) as unknown as FetchMock;
}

function makeClient(fetchImpl: FetchMock) {
  return new AtlaSentClient({
    apiKey: "ask_live_test",
    fetch: fetchImpl,
    timeoutMs: 5_000,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  });
}

const BASE_WIRE = {
  assertion_id: "asr_abc123",
  payload_hash: "deadbeef".repeat(8),
  reused: false,
};

describe("client.submitAssertion()", () => {
  it("POSTs to /v1/assertions with all required fields and returns the result", async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toMatch(/\/v1\/assertions$/);
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.assertion_type).toBe("github.ci_passed");
      expect(body.source_system).toBe("github");
      expect(body.subject_ref).toBe("myorg/myrepo@abc1234");
      return jsonResponse(BASE_WIRE);
    });
    const client = makeClient(fetchImpl);

    const result = await client.submitAssertion({
      assertion_type: "github.ci_passed",
      source_system: "github",
      subject_ref: "myorg/myrepo@abc1234",
    });

    expect(result.assertion_id).toBe("asr_abc123");
    expect(result.payload_hash).toBe("deadbeef".repeat(8));
    expect(result.reused).toBe(false);
  });

  it("sends optional fields when provided", async () => {
    const fetchImpl = mockFetch((url, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.actor_id).toBe("github-actions");
      expect(body.action_type).toBe("production.deploy");
      expect(body.trust_level).toBe("attested");
      expect(body.valid_until).toBe("2026-06-05T00:00:00Z");
      expect(body.payload).toEqual({ run_id: "123", sha: "abc" });
      return jsonResponse(BASE_WIRE);
    });
    const client = makeClient(fetchImpl);

    await client.submitAssertion({
      assertion_type: "github.ci_passed",
      source_system: "github",
      subject_ref: "myorg/myrepo@abc1234",
      actor_id: "github-actions",
      action_type: "production.deploy",
      trust_level: "attested",
      valid_until: "2026-06-05T00:00:00Z",
      payload: { run_id: "123", sha: "abc" },
    });
  });

  it("returns reused=true when the server deduplicates an existing assertion", async () => {
    const client = makeClient(
      mockFetch(() => jsonResponse({ ...BASE_WIRE, reused: true })),
    );

    const result = await client.submitAssertion({
      assertion_type: "github.ci_passed",
      source_system: "github",
      subject_ref: "myorg/myrepo@abc1234",
    });

    expect(result.reused).toBe(true);
  });

  it("defaults reused to false when the server omits the field", async () => {
    const wireWithoutReused = {
      assertion_id: "asr_abc123",
      payload_hash: "deadbeef".repeat(8),
    };
    const client = makeClient(
      mockFetch(() => jsonResponse(wireWithoutReused)),
    );

    const result = await client.submitAssertion({
      assertion_type: "github.ci_passed",
      source_system: "github",
      subject_ref: "myorg/myrepo@abc1234",
    });

    expect(result.reused).toBe(false);
  });

  it("includes Authorization: Bearer header on every request", async () => {
    const fetchImpl = mockFetch((url, init) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer ask_live_test");
      return jsonResponse(BASE_WIRE);
    });
    const client = makeClient(fetchImpl);
    await client.submitAssertion({
      assertion_type: "github.ci_passed",
      source_system: "github",
      subject_ref: "myorg/myrepo@abc1234",
    });
  });

  it("throws AtlaSentError with code=bad_request when assertion_type is missing", async () => {
    const client = makeClient(mockFetch(() => jsonResponse(BASE_WIRE)));

    await expect(
      client.submitAssertion({
        assertion_type: "",
        source_system: "github",
        subject_ref: "myorg/myrepo@abc1234",
      }),
    ).rejects.toThrow(AtlaSentError);

    await expect(
      client.submitAssertion({
        assertion_type: "",
        source_system: "github",
        subject_ref: "myorg/myrepo@abc1234",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("throws AtlaSentError with code=bad_request when source_system is missing", async () => {
    const client = makeClient(mockFetch(() => jsonResponse(BASE_WIRE)));

    await expect(
      client.submitAssertion({
        assertion_type: "github.ci_passed",
        source_system: "",
        subject_ref: "myorg/myrepo@abc1234",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("throws AtlaSentError with code=bad_request when subject_ref is missing", async () => {
    const client = makeClient(mockFetch(() => jsonResponse(BASE_WIRE)));

    await expect(
      client.submitAssertion({
        assertion_type: "github.ci_passed",
        source_system: "github",
        subject_ref: "",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("throws AtlaSentError on 403 (forbidden / missing scope)", async () => {
    const client = makeClient(
      mockFetch(() =>
        jsonResponse(
          { message: "Missing scope: assertions:write" },
          { status: 403 },
        ),
      ),
    );

    await expect(
      client.submitAssertion({
        assertion_type: "github.ci_passed",
        source_system: "github",
        subject_ref: "myorg/myrepo@abc1234",
      }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("throws AtlaSentError on 422 (malformed input from server)", async () => {
    const client = makeClient(
      mockFetch(() =>
        jsonResponse(
          { message: "assertion_type is invalid" },
          { status: 422 },
        ),
      ),
    );

    await expect(
      client.submitAssertion({
        assertion_type: "github.ci_passed",
        source_system: "github",
        subject_ref: "myorg/myrepo@abc1234",
      }),
    ).rejects.toMatchObject({ code: "bad_request", status: 422 });
  });

  it("throws AtlaSentError with code=bad_response when assertion_id is missing", async () => {
    const client = makeClient(
      mockFetch(() =>
        jsonResponse({ payload_hash: "deadbeef".repeat(8), reused: false }),
      ),
    );

    await expect(
      client.submitAssertion({
        assertion_type: "github.ci_passed",
        source_system: "github",
        subject_ref: "myorg/myrepo@abc1234",
      }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("throws AtlaSentError with code=bad_response when payload_hash is missing", async () => {
    const client = makeClient(
      mockFetch(() => jsonResponse({ assertion_id: "asr_abc123", reused: false })),
    );

    await expect(
      client.submitAssertion({
        assertion_type: "github.ci_passed",
        source_system: "github",
        subject_ref: "myorg/myrepo@abc1234",
      }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("does not send optional fields when they are undefined", async () => {
    const fetchImpl = mockFetch((url, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect("actor_id" in body).toBe(false);
      expect("action_type" in body).toBe(false);
      expect("trust_level" in body).toBe(false);
      expect("valid_until" in body).toBe(false);
      expect("payload" in body).toBe(false);
      return jsonResponse(BASE_WIRE);
    });
    const client = makeClient(fetchImpl);

    await client.submitAssertion({
      assertion_type: "github.ci_passed",
      source_system: "github",
      subject_ref: "myorg/myrepo@abc1234",
    });
  });
});
