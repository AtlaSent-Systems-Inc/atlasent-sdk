import { describe, it, expect, vi } from "vitest";
import {
  buildTrajectoryRequest,
  getAuthorizedTrajectory,
  hasAuthorizedTrajectory,
  verifyTrajectoryStep,
  TrajectoryDeviationError,
} from "../src/trajectory.js";
import type { EvaluateResponse } from "../src/types.js";

// ── helpers ────────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OPTS = { apiKey: "ask_test_traj", baseUrl: "https://api.atlasent.io" };

const VERIFY_OK = {
  on_trajectory: true,
  trajectory_position: 2,
  trajectory_complete: false,
  verified_at: "2026-01-01T00:00:01Z",
};

const DEVIATION_EVENT = {
  reason: "Step not authorized",
  trajectory_id: "traj_123",
  permit_id: "pt_456",
};

// ── buildTrajectoryRequest ─────────────────────────────────────────────────────

describe("buildTrajectoryRequest()", () => {
  it("returns a copy of the input request", () => {
    const req = {
      action: "run_step",
      agent: "agent:test",
      context: { environment: "staging" },
    };
    const result = buildTrajectoryRequest(req);
    expect(result).toEqual(req);
    expect(result).not.toBe(req);
  });
});

// ── getAuthorizedTrajectory ────────────────────────────────────────────────────

describe("getAuthorizedTrajectory()", () => {
  it("returns authorized_trajectory when present", () => {
    const traj = { steps: [], ttl_seconds: 300 };
    const response = { decision: "allow", authorized_trajectory: traj } as unknown as EvaluateResponse;
    expect(getAuthorizedTrajectory(response)).toBe(traj);
  });

  it("returns null when authorized_trajectory is absent", () => {
    const response = { decision: "allow" } as unknown as EvaluateResponse;
    expect(getAuthorizedTrajectory(response)).toBeNull();
  });
});

// ── hasAuthorizedTrajectory ────────────────────────────────────────────────────

describe("hasAuthorizedTrajectory()", () => {
  it("returns true when authorized_trajectory is present", () => {
    const response = {
      decision: "allow",
      authorized_trajectory: { steps: [], ttl_seconds: 300 },
    } as unknown as EvaluateResponse;
    expect(hasAuthorizedTrajectory(response)).toBe(true);
  });

  it("returns false when authorized_trajectory is absent", () => {
    const response = { decision: "allow" } as unknown as EvaluateResponse;
    expect(hasAuthorizedTrajectory(response)).toBe(false);
  });
});

// ── verifyTrajectoryStep ───────────────────────────────────────────────────────

describe("verifyTrajectoryStep()", () => {
  it("returns the server result when on_trajectory is true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(VERIFY_OK));

    const result = await verifyTrajectoryStep(
      OPTS,
      { permit_token: "pt_abc", current_step: "step_1" },
      fetchImpl,
    );

    expect(result.on_trajectory).toBe(true);
    expect(result.trajectory_position).toBe(2);
    expect(result.verified_at).toBe("2026-01-01T00:00:01Z");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("https://api.atlasent.io/v1/trajectory-verify");
  });

  it("throws TrajectoryDeviationError when on_trajectory is false (default throwOnDeviation)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ on_trajectory: false, trajectory_complete: false, deviation: DEVIATION_EVENT, verified_at: "2026-01-01T00:00:02Z" }),
    );

    await expect(
      verifyTrajectoryStep(
        OPTS,
        { permit_token: "pt_abc", current_step: "step_2" },
        fetchImpl,
      ),
    ).rejects.toThrow(TrajectoryDeviationError);
  });

  it("throws TrajectoryDeviationError with deviation reason when provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ on_trajectory: false, trajectory_complete: false, deviation: DEVIATION_EVENT, verified_at: "2026-01-01T00:00:02Z" }),
    );

    await expect(
      verifyTrajectoryStep(OPTS, { permit_token: "pt_abc", current_step: "step_2" }, fetchImpl),
    ).rejects.toThrow("Step not authorized");
  });

  it("uses fallback message when deviation has no reason", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ on_trajectory: false, trajectory_complete: false, verified_at: "2026-01-01T00:00:02Z" }),
    );

    await expect(
      verifyTrajectoryStep(OPTS, { permit_token: "pt_abc", current_step: "my_step" }, fetchImpl),
    ).rejects.toThrow("my_step");
  });

  it("does NOT throw when on_trajectory is false and throwOnDeviation=false", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ on_trajectory: false, trajectory_complete: false, deviation: DEVIATION_EVENT, verified_at: "2026-01-01T00:00:02Z" }),
    );

    const result = await verifyTrajectoryStep(
      { ...OPTS, throwOnDeviation: false },
      { permit_token: "pt_abc", current_step: "step_2" },
      fetchImpl,
    );
    expect(result.on_trajectory).toBe(false);
  });

  it("throws on non-200 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    );

    await expect(
      verifyTrajectoryStep(OPTS, { permit_token: "pt_abc", current_step: "step_1" }, fetchImpl),
    ).rejects.toThrow("trajectory-verify failed: 403");
  });

  it("uses custom baseUrl when provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(VERIFY_OK));

    await verifyTrajectoryStep(
      { apiKey: "ask_test_traj", baseUrl: "https://custom.example.com" },
      { permit_token: "pt_abc", current_step: "step_1" },
      fetchImpl,
    );

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("https://custom.example.com");
  });
});

// ── TrajectoryDeviationError ───────────────────────────────────────────────────

describe("TrajectoryDeviationError", () => {
  it("is an instance of Error", () => {
    const err = new TrajectoryDeviationError("deviated", { reason: "bad step" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TrajectoryDeviationError);
  });

  it("sets name, message, deviation, trajectoryId, permitId", () => {
    const err = new TrajectoryDeviationError("msg", { reason: "r" }, "traj_1", "pt_1");
    expect(err.name).toBe("TrajectoryDeviationError");
    expect(err.message).toBe("msg");
    expect(err.deviation).toEqual({ reason: "r" });
    expect(err.trajectoryId).toBe("traj_1");
    expect(err.permitId).toBe("pt_1");
  });

  it("leaves trajectoryId and permitId undefined when not provided", () => {
    const err = new TrajectoryDeviationError("msg", null);
    expect(err.trajectoryId).toBeUndefined();
    expect(err.permitId).toBeUndefined();
  });
});
