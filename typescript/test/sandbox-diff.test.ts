import { describe, expect, it } from "vitest";
import {
  isSandboxDiffPopulated,
  type SandboxDiff,
  type SandboxDiffEmpty,
} from "../src/index.js";

describe("isSandboxDiffPopulated", () => {
  it("narrows to SandboxDiff for a run with staging rows", () => {
    const diff: SandboxDiff = {
      simulation_run_id: "run_1",
      org_id: "org_1",
      final_status: "running",
      mode: "simulation",
      total_writes: 2,
      summary: { hitl_escalations: { total: 2, insert: 1, update: 1, delete: 0 } },
      writes: [],
    };
    expect(isSandboxDiffPopulated(diff)).toBe(true);
  });

  it("narrows to false when the run has been torn down", () => {
    const empty: SandboxDiffEmpty = {
      simulation_run_id: "run_1",
      status: "completed",
      mode: "simulation",
      torn_down: true,
      total_writes: 0,
      summary: {},
      writes: [],
    };
    expect(isSandboxDiffPopulated(empty)).toBe(false);
  });
});
