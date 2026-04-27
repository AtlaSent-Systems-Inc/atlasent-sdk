import { describe, expect, it, vi } from "vitest";

import {
  V2Client,
  V2Error,
  type ConsumeResponse,
  type ProofVerificationResult,
} from "../src/index.js";

function mockFetch(status: number, body: unknown): typeof fetch {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  return vi.fn(async () =>
    new Response(json, {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("V2Client constructor", () => {
  it("requires apiKey", () => {
    expect(() => new V2Client({ apiKey: "" })).toThrow(V2Error);
  });

  it("accepts a custom baseUrl and trims trailing slashes", async () => {
    const calls: string[] = [];
    const fetchSpy: typeof fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          proof_id: "11111111-1111-1111-1111-111111111111",
          execution_status: "executed",
          audit_hash: "a".repeat(64),
        } satisfies ConsumeResponse),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = new V2Client({
      apiKey: "k",
      baseUrl: "https://example.test/api/",
      fetch: fetchSpy,
    });
    await client.consume({
      permitId: "p_1",
      payloadHash: "f".repeat(64),
      executionStatus: "executed",
    });
    expect(calls[0]).toBe("https://example.test/api/v2/permits/p_1/consume");
  });
});

describe("V2Client.consume", () => {
  it("returns a ConsumeResponse on success", async () => {
    const expected: ConsumeResponse = {
      proof_id: "11111111-1111-1111-1111-111111111111",
      execution_status: "executed",
      audit_hash: "a".repeat(64),
    };
    const client = new V2Client({ apiKey: "k", fetch: mockFetch(200, expected) });
    const out = await client.consume({
      permitId: "p_1",
      payloadHash: "f".repeat(64),
      executionStatus: "executed",
    });
    expect(out).toEqual(expected);
  });

  it("sends the correct body shape including api_key", async () => {
    let captured: { url: string; init?: RequestInit } = { url: "" };
    const fetchSpy: typeof fetch = vi.fn(async (url, init) => {
      captured = { url: String(url), init };
      return new Response(
        JSON.stringify({
          proof_id: "p",
          execution_status: "executed",
          audit_hash: "a".repeat(64),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "ask_live_xyz", fetch: fetchSpy });
    await client.consume({
      permitId: "permit_42",
      payloadHash: "0".repeat(64),
      executionStatus: "executed",
      executionHash: "9".repeat(64),
    });

    expect(captured.url).toBe(
      "https://api.atlasent.io/v2/permits/permit_42/consume",
    );
    expect(captured.init?.method).toBe("POST");
    const body = JSON.parse(captured.init?.body as string);
    expect(body).toEqual({
      permit_id: "permit_42",
      payload_hash: "0".repeat(64),
      execution_status: "executed",
      execution_hash: "9".repeat(64),
      api_key: "ask_live_xyz",
    });
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ask_live_xyz");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("omits execution_hash from the body when not supplied", async () => {
    let body: Record<string, unknown> = {};
    const fetchSpy: typeof fetch = vi.fn(async (_url, init) => {
      body = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          proof_id: "p",
          execution_status: "failed",
          audit_hash: "a".repeat(64),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    await client.consume({
      permitId: "p_1",
      payloadHash: "f".repeat(64),
      executionStatus: "failed",
    });
    expect(body.execution_hash).toBeUndefined();
  });

  it("URL-encodes the permit id", async () => {
    let url = "";
    const fetchSpy: typeof fetch = vi.fn(async (u) => {
      url = String(u);
      return new Response(
        JSON.stringify({
          proof_id: "p",
          execution_status: "executed",
          audit_hash: "a".repeat(64),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    await client.consume({
      permitId: "permit/with/slash",
      payloadHash: "f".repeat(64),
      executionStatus: "executed",
    });
    expect(url).toContain("permit%2Fwith%2Fslash");
  });

  it("raises V2Error on 401 with invalid_api_key code", async () => {
    const client = new V2Client({ apiKey: "k", fetch: mockFetch(401, {}) });
    await expect(
      client.consume({
        permitId: "p",
        payloadHash: "f".repeat(64),
        executionStatus: "executed",
      }),
    ).rejects.toMatchObject({
      name: "V2Error",
      status: 401,
      code: "invalid_api_key",
    });
  });

  it("raises V2Error on 500 with http_error code", async () => {
    const client = new V2Client({
      apiKey: "k",
      fetch: mockFetch(500, { error: "boom" }),
    });
    await expect(
      client.consume({
        permitId: "p",
        payloadHash: "f".repeat(64),
        executionStatus: "executed",
      }),
    ).rejects.toMatchObject({
      name: "V2Error",
      status: 500,
      code: "http_error",
      responseBody: { error: "boom" },
    });
  });

  it("raises V2Error on network failure", async () => {
    const fetchSpy: typeof fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    await expect(
      client.consume({
        permitId: "p",
        payloadHash: "f".repeat(64),
        executionStatus: "executed",
      }),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("raises V2Error on timeout", async () => {
    const fetchSpy: typeof fetch = vi.fn(async (_url, init) => {
      await new Promise((resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
        setTimeout(resolve, 200);
      });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const client = new V2Client({
      apiKey: "k",
      timeoutMs: 10,
      fetch: fetchSpy,
    });
    await expect(
      client.consume({
        permitId: "p",
        payloadHash: "f".repeat(64),
        executionStatus: "executed",
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("raises V2Error on malformed JSON in 2xx response", async () => {
    const client = new V2Client({
      apiKey: "k",
      fetch: mockFetch(200, "{not-json"),
    });
    await expect(
      client.consume({
        permitId: "p",
        payloadHash: "f".repeat(64),
        executionStatus: "executed",
      }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("V2Client.verifyProof", () => {
  it("returns a ProofVerificationResult on success", async () => {
    const expected: ProofVerificationResult = {
      verification_status: "valid",
      proof_id: "22222222-2222-2222-2222-222222222222",
      checks: [
        { name: "signature", passed: true },
        { name: "chain_link", passed: true },
        { name: "payload_hash", passed: true },
        { name: "policy_version", passed: true },
        { name: "execution_coherence", passed: true },
      ],
    };
    const client = new V2Client({ apiKey: "k", fetch: mockFetch(200, expected) });
    const out = await client.verifyProof(expected.proof_id);
    expect(out).toEqual(expected);
  });

  it("posts to /v2/proofs/:id/verify with api_key body", async () => {
    let captured: { url: string; body: Record<string, unknown> } = {
      url: "",
      body: {},
    };
    const fetchSpy: typeof fetch = vi.fn(async (url, init) => {
      captured = {
        url: String(url),
        body: JSON.parse(init?.body as string),
      };
      return new Response(
        JSON.stringify({
          verification_status: "invalid",
          proof_id: "x",
          checks: [{ name: "signature", passed: false, reason: "invalid_signature" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "ask_xyz", fetch: fetchSpy });
    await client.verifyProof("proof_42");

    expect(captured.url).toBe("https://api.atlasent.io/v2/proofs/proof_42/verify");
    expect(captured.body).toEqual({ api_key: "ask_xyz" });
  });

  it("surfaces invalid status with failure reason", async () => {
    const result: ProofVerificationResult = {
      verification_status: "invalid",
      proof_id: "p",
      checks: [
        { name: "signature", passed: false, reason: "invalid_signature" },
      ],
    };
    const client = new V2Client({ apiKey: "k", fetch: mockFetch(200, result) });
    const out = await client.verifyProof("p");
    expect(out.verification_status).toBe("invalid");
    expect(out.checks[0]?.passed).toBe(false);
    expect(out.checks[0]?.reason).toBe("invalid_signature");
  });

  it("rejects empty proofId before sending", async () => {
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    await expect(client.verifyProof("")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
