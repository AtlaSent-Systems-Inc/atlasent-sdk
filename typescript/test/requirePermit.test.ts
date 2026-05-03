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
  AtlaSentDeniedError,
  AtlaSentError,
  classifyCommand,
  configure,
  requirePermit,
  type ProtectedAction,
} from "../src/index.js";
import { __resetSharedClientForTests } from "../src/protect.js";

type FetchMock = MockedFunction<typeof fetch>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EVALUATE_ALLOW_WIRE = {
  permitted: true,
  decision_id: "dec_alpha",
  reason: "policy authorized",
  audit_hash: "hash_alpha",
  timestamp: "2026-04-22T10:00:00Z",
};

const EVALUATE_DENY_WIRE = {
  permitted: false,
  decision_id: "dec_beta",
  reason: "denied by policy",
  audit_hash: "hash_beta",
  timestamp: "2026-04-22T10:01:00Z",
};

const VERIFY_OK_WIRE = {
  verified: true,
  outcome: "verified",
  permit_hash: "permit_alpha",
  timestamp: "2026-04-22T10:00:01Z",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetchSequence(responses: Response[]): FetchMock {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("mock fetch queue exhausted");
    return next;
  }) as unknown as FetchMock;
}

const SAMPLE_ACTION: ProtectedAction = {
  action_type: "database.table.drop",
  actor_id: "agent:code-agent",
  resource_id: "prod-db.users",
  environment: "production",
  context: {
    reversibility: "irreversible",
    blast_radius: "customer_data",
  },
};

// ── classifyCommand ───────────────────────────────────────────────────────────

describe("classifyCommand", () => {
  it("is reachable as both named import and default-export method", () => {
    expect(typeof classifyCommand).toBe("function");
    expect(typeof atlasent.classifyCommand).toBe("function");
    expect(atlasent.classifyCommand).toBe(classifyCommand);
  });

  it.each([
    ["rm -rf /important"],
    ["rm -rf /var/data && echo done"],
    ["DROP TABLE users"],
    ["drop table sessions;"],
    ["DROP DATABASE prod"],
    ["DELETE FROM audit_logs WHERE created_at < '2020-01-01'"],
    ["delete from sessions"],
    ["TRUNCATE TABLE events"],
    ["truncate table logs"],
    ["railway volume delete vol-123"],
    ["kubectl delete pod web-5d4f"],
    ["terraform destroy -auto-approve"],
  ])('returns "destructive.command" for: %s', (cmd) => {
    expect(classifyCommand(cmd)).toBe("destructive.command");
  });

  it.each([
    ["ls -la"],
    ["npm install"],
    ["git status"],
    ["SELECT * FROM users"],
    ["UPDATE users SET active = true WHERE id = 1"],
    ["INSERT INTO events VALUES (1, 'login')"],
    ["echo hello"],
    ["kubectl get pods"],
    ["terraform plan"],
  ])("returns null for safe command: %s", (cmd) => {
    expect(classifyCommand(cmd)).toBeNull();
  });
});

// ── requirePermit ─────────────────────────────────────────────────────────────

describe("requirePermit", () => {
  const ORIGINAL_ENV = process.env.ATLASENT_API_KEY;

  beforeEach(() => {
    __resetSharedClientForTests();
    delete process.env.ATLASENT_API_KEY;
  });

  afterEach(() => {
    __resetSharedClientForTests();
    if (ORIGINAL_ENV !== undefined) process.env.ATLASENT_API_KEY = ORIGINAL_ENV;
    else delete process.env.ATLASENT_API_KEY;
  });

  it("is reachable as both named import and default-export method", () => {
    expect(typeof requirePermit).toBe("function");
    expect(typeof atlasent.requirePermit).toBe("function");
    expect(atlasent.requirePermit).toBe(requirePermit);
  });

  it("calls the executor and returns its result when authorized", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const executor = vi.fn(async () => "side-effect-done");
    const result = await requirePermit(SAMPLE_ACTION, executor);

    expect(result).toBe("side-effect-done");
    expect(executor).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2); // evaluate + verifyPermit
  });

  it("never calls the executor on policy deny", async () => {
    const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const executor = vi.fn(async () => "should-not-run");

    let caught: unknown;
    try {
      await requirePermit(SAMPLE_ACTION, executor);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtlaSentDeniedError);
    expect(executor).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never calls the executor on transport failure", async () => {
    const fetchImpl = mockFetchSequence([
      new Response("internal server error", { status: 500 }),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const executor = vi.fn(async () => "should-not-run");

    let caught: unknown;
    try {
      await requirePermit(SAMPLE_ACTION, executor);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtlaSentError);
    expect(caught).not.toBeInstanceOf(AtlaSentDeniedError);
    expect(executor).not.toHaveBeenCalled();
  });

  it("forwards action_type, actor_id, resource_id, and environment in the evaluate body", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    await requirePermit(SAMPLE_ACTION, async () => undefined);

    const [, evalInit] = fetchImpl.mock.calls[0]!;
    const evalBody = JSON.parse(evalInit!.body as string);

    expect(evalBody.action_type).toBe(SAMPLE_ACTION.action_type);
    expect(evalBody.actor_id).toBe(SAMPLE_ACTION.actor_id);
    expect(evalBody.context.resource_id).toBe(SAMPLE_ACTION.resource_id);
    expect(evalBody.context.environment).toBe(SAMPLE_ACTION.environment);
    expect(evalBody.context.reversibility).toBe("irreversible");
    expect(evalBody.context.blast_radius).toBe("customer_data");
  });

  it("preserves the executor return type generically", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const result: { deleted: boolean; id: string } = await requirePermit(
      SAMPLE_ACTION,
      async () => ({ deleted: true, id: "row_1" }),
    );

    expect(result).toEqual({ deleted: true, id: "row_1" });
  });
});
