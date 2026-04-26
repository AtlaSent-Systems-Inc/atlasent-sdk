/**
 * Tests for the workflow-side signal helper.
 *
 * Strategy: stub `@temporalio/workflow` via `vi.mock` (hoisted) so we
 * can assert what `setHandler` registers without standing up a real
 * Temporal worker / workflow runtime. The signal-firing path is
 * exercised by manually invoking the captured handler with a
 * synthetic `RevokeAtlaSentPermitsArgs`.
 *
 * Companion to `withAtlaSentActivity.test.ts` — both stub the
 * `@temporalio/*` import boundary the same way.
 */

import { describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted; state must come from `vi.hoisted`.
const {
  setHandlerMock,
  proxyActivitiesMock,
  workflowInfoMock,
  defineSignalSentinel,
  bulkRevokeProxy,
} = vi.hoisted(() => {
  const bulkRevokeProxy = vi.fn(async () => undefined);
  const proxyObj = { bulkRevokeAtlaSentPermits: bulkRevokeProxy };
  const proxyActivitiesMock = vi.fn(() => proxyObj);
  // Capture every setHandler call; tests inspect.
  const setHandlerMock = vi.fn();
  const workflowInfoMock = vi.fn(() => ({
    workflowId: "wf-1",
    runId: "run-abc",
  }));
  // `defineSignal` returns an opaque object; we don't care about its
  // shape, just that the same object is passed to `setHandler`.
  const defineSignalSentinel = { __kind: "signal-def" };
  return {
    setHandlerMock,
    proxyActivitiesMock,
    workflowInfoMock,
    defineSignalSentinel,
    bulkRevokeProxy,
  };
});

vi.mock("@temporalio/workflow", () => ({
  defineSignal: vi.fn(() => defineSignalSentinel),
  proxyActivities: proxyActivitiesMock,
  setHandler: setHandlerMock,
  workflowInfo: workflowInfoMock,
}));

import {
  bulkRevokeAtlaSentPermits,
  BulkRevokeNotImplementedError,
  installRevokeHandler,
  RevokeAtlaSentPermitsSignal,
} from "../src/index.js";

// ── installRevokeHandler ─────────────────────────────────────────────


describe("installRevokeHandler", () => {
  it("registers a handler for RevokeAtlaSentPermitsSignal", () => {
    setHandlerMock.mockClear();
    installRevokeHandler();
    expect(setHandlerMock).toHaveBeenCalledTimes(1);
    expect(setHandlerMock.mock.calls[0]?.[0]).toBe(RevokeAtlaSentPermitsSignal);
    expect(typeof setHandlerMock.mock.calls[0]?.[1]).toBe("function");
  });

  it("uses proxyActivities with a 30s default startToCloseTimeout", () => {
    proxyActivitiesMock.mockClear();
    installRevokeHandler();
    expect(proxyActivitiesMock).toHaveBeenCalledWith({
      startToCloseTimeout: "30s",
    });
  });

  it("respects a custom startToCloseTimeout", () => {
    proxyActivitiesMock.mockClear();
    installRevokeHandler({ startToCloseTimeout: "5m" });
    expect(proxyActivitiesMock).toHaveBeenCalledWith({
      startToCloseTimeout: "5m",
    });
  });

  it("does not call proxyActivities when activities are injected", () => {
    proxyActivitiesMock.mockClear();
    const customActivity = vi.fn(async () => undefined);
    installRevokeHandler({
      activities: { bulkRevokeAtlaSentPermits: customActivity },
    });
    expect(proxyActivitiesMock).not.toHaveBeenCalled();
  });

  it("the handler enriches signal args with workflow + run id", async () => {
    setHandlerMock.mockClear();
    bulkRevokeProxy.mockClear();
    workflowInfoMock.mockReturnValue({
      workflowId: "deploy-wf",
      runId: "run-42",
    });

    installRevokeHandler();
    const handler = setHandlerMock.mock.calls[0]?.[1] as (
      args: { reason: string; revoker_id?: string },
    ) => Promise<void>;

    await handler({ reason: "operator pause", revoker_id: "alice" });

    expect(bulkRevokeProxy).toHaveBeenCalledWith({
      reason: "operator pause",
      revoker_id: "alice",
      workflow_id: "deploy-wf",
      run_id: "run-42",
    });
  });

  it("the handler delegates to a custom activity reference", async () => {
    setHandlerMock.mockClear();
    const customActivity = vi.fn(async () => undefined);
    workflowInfoMock.mockReturnValue({
      workflowId: "my-wf",
      runId: "my-run",
    });

    installRevokeHandler({
      activities: { bulkRevokeAtlaSentPermits: customActivity },
    });
    const handler = setHandlerMock.mock.calls[0]?.[1] as (
      args: { reason: string },
    ) => Promise<void>;

    await handler({ reason: "ttl" });

    expect(customActivity).toHaveBeenCalledWith({
      reason: "ttl",
      workflow_id: "my-wf",
      run_id: "my-run",
    });
  });
});

// ── bulkRevokeAtlaSentPermits stub ──────────────────────────────────


describe("bulkRevokeAtlaSentPermits stub", () => {
  it("throws BulkRevokeNotImplementedError with workflow context", async () => {
    await expect(
      bulkRevokeAtlaSentPermits({
        reason: "operator pause",
        workflow_id: "wf-1",
        run_id: "run-abc",
      }),
    ).rejects.toThrow(BulkRevokeNotImplementedError);
  });

  it("error message names the workflow + run + reason", async () => {
    await expect(
      bulkRevokeAtlaSentPermits({
        reason: "ttl_expired",
        workflow_id: "wf-x",
        run_id: "run-y",
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("wf-x"),
    });
  });

  it("preserves a typed name on the error class", async () => {
    try {
      await bulkRevokeAtlaSentPermits({
        reason: "test",
        workflow_id: "w",
        run_id: "r",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(BulkRevokeNotImplementedError);
      expect((err as Error).name).toBe("BulkRevokeNotImplementedError");
    }
  });
});
