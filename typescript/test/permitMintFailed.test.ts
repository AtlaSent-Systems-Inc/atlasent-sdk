/**
 * Tests for the permit-mint operational-error taxonomy (atlasent-api #1634).
 *
 * Policy evaluation resolving ALLOW but AtlaSent being unable to materialize
 * executable authority (the permit could not be minted/signed) is a distinct
 * operational/infrastructure failure — not a DENY, HOLD, or ESCALATE. This
 * must be structurally distinguishable (via `instanceof`), not just by
 * inspecting a string field, matching how DENY/HOLD/ESCALATE are already
 * modeled and mirroring the Python SDK's `AtlaSentPermitMintFailedError`.
 *
 * Two wire shapes both raise `AtlaSentPermitMintFailedError`:
 *
 * 1. A non-2xx status (503 recoverable / 500 invariant) carrying
 *    `{"error": "permit_signing_unavailable", ...}`.
 * 2. A defensive fallback: a 2xx response with `decision: "allow"` but no
 *    `permit_token`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";

import atlasent, {
  AtlaSentClient,
  AtlaSentDeniedError,
  AtlaSentError,
  AtlaSentPermitMintFailedError,
  configure,
} from "../src/index.js";
import { __resetSharedClientForTests } from "../src/protect.js";

type FetchMock = MockedFunction<typeof fetch>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function mintFailureResponse(
  status: number,
  message = "signer unavailable",
): Response {
  return new Response(
    JSON.stringify({ error: "permit_signing_unavailable", message }),
    { status, headers: { "Content-Type": "application/json" } },
  );
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

function mockFetchSequence(responses: Response[]): FetchMock {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("mock fetch queue exhausted");
    return next;
  }) as unknown as FetchMock;
}

function makeClient(
  fetchImpl: FetchMock,
  overrides: Partial<ConstructorParameters<typeof AtlaSentClient>[0]> = {},
) {
  return new AtlaSentClient({
    apiKey: "ask_live_test",
    fetch: fetchImpl,
    timeoutMs: 5_000,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    ...overrides,
  });
}

describe("AtlaSentClient — permit-mint failure (wire-level 503/500 envelope)", () => {
  it("503 permit_signing_unavailable raises a distinct error class", async () => {
    const client = makeClient(mockFetch(() => mintFailureResponse(503)));

    let caught: unknown;
    try {
      await client.evaluate({ agent: "bot", action: "ci.deploy" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtlaSentPermitMintFailedError);
    expect(caught).toBeInstanceOf(AtlaSentError); // still catchable as the base class
    const err = caught as AtlaSentPermitMintFailedError;
    expect(err.code).toBe("permit_signing_unavailable");
    expect(err.status).toBe(503);
    expect(err.decision).toBe("allow");
  });

  it("500 permit_signing_unavailable also raises the distinct class", async () => {
    // The architecture decision allows either status for a mint failure
    // (503 recoverable / 500 invariant) — both must classify the same way.
    const client = makeClient(mockFetch(() => mintFailureResponse(500)));

    await expect(
      client.evaluate({ agent: "bot", action: "ci.deploy" }),
    ).rejects.toBeInstanceOf(AtlaSentPermitMintFailedError);
  });

  it("mint failure is not an instance of AtlaSentDeniedError", async () => {
    // Load-bearing assertion: application code must be able to tell
    // "policy denied me" apart from "policy allowed, but AtlaSent could
    // not materialize executable authority."
    const client = makeClient(mockFetch(() => mintFailureResponse(503)));

    let caught: unknown;
    try {
      await client.evaluate({ agent: "bot", action: "ci.deploy" });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AtlaSentDeniedError);
  });

  it("an unrelated 5xx error still raises the generic AtlaSentError", async () => {
    const client = makeClient(
      mockFetch(
        () =>
          new Response(JSON.stringify({ error: "internal_error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    let caught: unknown;
    try {
      await client.evaluate({ agent: "bot", action: "ci.deploy" });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AtlaSentPermitMintFailedError);
    expect((caught as AtlaSentError).code).toBe("server_error");
  });

  it("a non-JSON 5xx body still raises the generic AtlaSentError", async () => {
    // Regression guard: a gateway timeout page or other non-JSON body must
    // fall through to the pre-existing generic path, not crash the
    // mint-failure parser.
    const client = makeClient(
      mockFetch(
        () => new Response("<html>Bad Gateway</html>", { status: 500 }),
      ),
    );

    let caught: unknown;
    try {
      await client.evaluate({ agent: "bot", action: "ci.deploy" });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AtlaSentPermitMintFailedError);
  });

  it("classifies only on the terminal raise — a transient 503 that recovers on retry still returns normally", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls++;
      if (calls === 1) return mintFailureResponse(503);
      return jsonResponse({
        decision: "allow",
        permit_token: "pt_xyz",
        request_id: "r1",
      });
    });
    const client = makeClient(fetchImpl, {
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    });

    const result = await client.evaluate({ agent: "bot", action: "ci.deploy" });
    expect(calls).toBe(2);
    expect(result.permitId).toBe("pt_xyz");
  });

  it("a 2xx allow response missing permit_token raises the distinct class", async () => {
    const client = makeClient(
      mockFetch(() => jsonResponse({ decision: "allow", bundle_version: "v3" })),
    );

    let caught: unknown;
    try {
      await client.evaluate({ agent: "bot", action: "ci.deploy" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AtlaSentPermitMintFailedError);
    const err = caught as AtlaSentPermitMintFailedError;
    expect(err.decision).toBe("allow");
    expect(err.code).toBe("permit_signing_unavailable");
  });
});

describe("protect() — permit-mint failure propagates unwrapped", () => {
  beforeEach(() => {
    __resetSharedClientForTests();
    delete process.env.ATLASENT_API_KEY;
  });

  afterEach(() => {
    __resetSharedClientForTests();
    delete process.env.ATLASENT_API_KEY;
  });

  it("does not coerce a mint failure into AtlaSentDeniedError", async () => {
    const fetchImpl = mockFetchSequence([mintFailureResponse(503)]);
    configure({
      apiKey: "ask_live_test",
      fetch: fetchImpl,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });

    let caught: unknown;
    try {
      await atlasent.protect({
        agent: "bot",
        action: "ci.deploy",
        context: { environment: "production" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtlaSentPermitMintFailedError);
    expect(caught).not.toBeInstanceOf(AtlaSentDeniedError);
  });
});
