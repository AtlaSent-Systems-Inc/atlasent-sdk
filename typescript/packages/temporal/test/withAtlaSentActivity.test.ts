/**
 * Tests for `withAtlaSentActivity`.
 *
 * Strategy: stub both peer deps at the module-import boundary —
 * `@temporalio/activity::Context` and `@atlasent/sdk::protect` —
 * with vitest's `vi.mock`. That lets us exercise the wrapper's
 * resolver / context-enrichment / call-order logic without
 * standing up a real Temporal worker or AtlaSent staging tenant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` calls are hoisted to the top of the file, so any state
// they reference must come from `vi.hoisted` (also hoisted) — a
// regular `const` would fire ReferenceError at mock-factory time.
const { fixtureInfo, protectMock } = vi.hoisted(() => {
  const fixtureInfo = {
    workflowExecution: { workflowId: "wf-1", runId: "run-abc" },
    activityId: "act-1",
    activityType: "deployActivity",
    attempt: 1,
  };
  const protectMock = vi.fn(async () => ({
    permit_id: "permit-1",
    permit_hash: "hash-1",
    audit_hash: "audit-1",
    reason: "ok",
    timestamp: "2026-04-25T00:00:00Z",
  }));
  return { fixtureInfo, protectMock };
});

vi.mock("@temporalio/activity", () => ({
  Context: {
    current: () => ({ info: fixtureInfo }),
  },
}));

vi.mock("@atlasent/sdk", () => ({
  protect: protectMock,
}));

// Import AFTER mocks so the wrapper picks up the stubs.
import { withAtlaSentActivity } from "../src/withAtlaSentActivity.js";

beforeEach(() => {
  protectMock.mockClear();
  // Reset fixture to defaults each test so cross-test state doesn't leak.
  fixtureInfo.workflowExecution = { workflowId: "wf-1", runId: "run-abc" };
  fixtureInfo.activityId = "act-1";
  fixtureInfo.activityType = "deployActivity";
  fixtureInfo.attempt = 1;
});

afterEach(() => {
  vi.clearAllMocks();
});

interface ProtectArgs {
  agent: string;
  action: string;
  context: Record<string, unknown> & {
    _atlasent_temporal: {
      workflow_id: string;
      run_id: string;
      activity_id: string;
      activity_type: string;
      attempt: number;
    };
  };
}

function protectCall(index = 0): ProtectArgs {
  const calls = protectMock.mock.calls as unknown as ProtectArgs[][];
  const call = calls[index];
  if (!call) throw new Error(`protect not called at index ${index}`);
  return call[0]!;
}

describe("withAtlaSentActivity — call ordering + protect args", () => {
  it("calls protect() before activityFn and returns activityFn's result", async () => {
    const activityFn = vi.fn(async (input: { sha: string }) => `deployed:${input.sha}`);

    const wrapped = withAtlaSentActivity(activityFn, {
      action: "deploy_to_production",
    });
    const result = await wrapped({ sha: "abc123" });

    expect(result).toBe("deployed:abc123");
    expect(protectMock).toHaveBeenCalledTimes(1);
    expect(activityFn).toHaveBeenCalledTimes(1);
    // Order: protect first, then activityFn.
    expect((protectMock as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0]).toBeLessThan(
      (activityFn as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0]!,
    );
  });

  it("passes a string `action` straight through", async () => {
    const wrapped = withAtlaSentActivity(async () => "ok", {
      action: "deploy_to_production",
    });
    await wrapped(undefined as unknown as never);
    expect(protectMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "deploy_to_production" }),
    );
  });

  it("resolves a function `action` per invocation", async () => {
    const actionFn = vi.fn((input: { kind: string }) => `do_${input.kind}`);
    const wrapped = withAtlaSentActivity(async () => "ok", {
      action: actionFn,
    });
    await wrapped({ kind: "deploy" });
    await wrapped({ kind: "rollback" });
    expect(actionFn).toHaveBeenCalledTimes(2);
    expect(protectMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: "do_deploy" }),
    );
    expect(protectMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: "do_rollback" }),
    );
  });

  it("resolves an async-function `action`", async () => {
    const wrapped = withAtlaSentActivity(async () => "ok", {
      action: async (input: { kind: string }) => `async_${input.kind}`,
    });
    await wrapped({ kind: "x" });
    expect(protectMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "async_x" }),
    );
  });

  it("resolves a function `context` per invocation", async () => {
    const wrapped = withAtlaSentActivity(async () => "ok", {
      action: "deploy",
      context: (input: { sha: string }) => ({ commit: input.sha }),
    });
    await wrapped({ sha: "abc" });
    expect(protectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ commit: "abc" }),
      }),
    );
  });

  it("merges caller context with `_atlasent_temporal` metadata", async () => {
    const wrapped = withAtlaSentActivity(async () => "ok", {
      action: "deploy",
      context: { commit: "abc", env: "prod" },
    });
    await wrapped({});
    const protectArgs = protectCall();
    expect(protectArgs.context).toEqual({
      commit: "abc",
      env: "prod",
      _atlasent_temporal: {
        workflow_id: "wf-1",
        run_id: "run-abc",
        activity_id: "act-1",
        activity_type: "deployActivity",
        attempt: 1,
      },
    });
  });

  it("uses an empty object when no context is provided", async () => {
    const wrapped = withAtlaSentActivity(async () => "ok", {
      action: "deploy",
    });
    await wrapped({});
    const protectArgs = protectCall();
    expect(protectArgs.context).toEqual({
      _atlasent_temporal: expect.any(Object),
    });
  });

  it("defaults agent to `<workflowId>:<activityType>`", async () => {
    fixtureInfo.workflowExecution.workflowId = "deploy-wf";
    fixtureInfo.activityType = "rolloutActivity";
    const wrapped = withAtlaSentActivity(async () => "ok", { action: "deploy" });
    await wrapped({});
    expect(protectMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "deploy-wf:rolloutActivity" }),
    );
  });

  it("respects an explicit `agent` literal", async () => {
    const wrapped = withAtlaSentActivity(async () => "ok", {
      action: "deploy",
      agent: "deploy-bot",
    });
    await wrapped({});
    expect(protectMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "deploy-bot" }),
    );
  });

  it("respects a function `agent` resolver", async () => {
    const wrapped = withAtlaSentActivity(async () => "ok", {
      action: "deploy",
      agent: (input: { user: string }) => `user:${input.user}`,
    });
    await wrapped({ user: "smith" });
    expect(protectMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "user:smith" }),
    );
  });

  it("uses the current attempt in the metadata (retry support)", async () => {
    fixtureInfo.attempt = 4;
    const wrapped = withAtlaSentActivity(async () => "ok", { action: "deploy" });
    await wrapped({});
    const protectArgs = protectCall();
    expect(protectArgs.context._atlasent_temporal.attempt).toBe(4);
  });
});

describe("withAtlaSentActivity — error propagation", () => {
  it("rethrows protect()'s error and skips the activity", async () => {
    const denyError = new Error("policy denied");
    protectMock.mockImplementationOnce(async () => {
      throw denyError;
    });
    const activityFn = vi.fn(async () => "ok");
    const wrapped = withAtlaSentActivity(activityFn, { action: "deploy" });

    await expect(wrapped({})).rejects.toThrow("policy denied");
    expect(activityFn).not.toHaveBeenCalled();
  });

  it("rethrows the activity's error after a successful protect()", async () => {
    const wrapped = withAtlaSentActivity(
      async () => {
        throw new Error("activity blew up");
      },
      { action: "deploy" },
    );
    await expect(wrapped({})).rejects.toThrow("activity blew up");
    expect(protectMock).toHaveBeenCalledTimes(1);
  });
});

describe("withAtlaSentActivity — type signature", () => {
  it("preserves the wrapped activity's input + output types", async () => {
    const original = async (input: { count: number }) => input.count * 2;
    const wrapped = withAtlaSentActivity(original, { action: "double" });
    // Compile-time: input must be { count: number }; result must be number.
    const out: number = await wrapped({ count: 21 });
    expect(out).toBe(42);
  });
});
