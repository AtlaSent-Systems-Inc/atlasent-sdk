import { describe, expect, it, vi } from "vitest";

import { makeClinicalTrialsClient } from "../src/clinical.js";

function makeMocks() {
  const getFn = vi.fn();
  const postFn = vi.fn();
  const client = makeClinicalTrialsClient(getFn as never, postFn as never);
  return { client, getFn, postFn };
}

const TRIAL = {
  id: "ctb_1",
  org_id: "org_1",
  trial_id: "NCT12345678",
  trial_name: "Phase III",
  blinding_type: "double_blind",
  status: "blinded" as const,
  established_by: "pi",
  randomization_code_hash: "a".repeat(64),
  created_at: "2026-07-10T00:00:00Z",
};

describe("makeClinicalTrialsClient — reads", () => {
  it("list() sends status/limit/offset query and returns trials", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { trials: [TRIAL] } });
    const resp = await client.list({ status: "blinded", limit: 10, offset: 5 });
    expect(resp.trials[0]!.trial_id).toBe("NCT12345678");
    const [path, query] = getFn.mock.calls[0]!;
    expect(path).toBe("/v1/clinical-unblind");
    expect((query as URLSearchParams).get("status")).toBe("blinded");
    expect((query as URLSearchParams).get("limit")).toBe("10");
    expect((query as URLSearchParams).get("offset")).toBe("5");
  });

  it("list() with no filters omits the query string", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { trials: [] } });
    await client.list();
    expect(getFn.mock.calls[0]![1]).toBeUndefined();
  });

  it("get() queries by trial_id", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { trial: TRIAL } });
    const resp = await client.get("NCT12345678");
    expect(resp.trial.status).toBe("blinded");
    expect((getFn.mock.calls[0]![1] as URLSearchParams).get("trial_id")).toBe("NCT12345678");
  });

  it("history() hits /history with trial_id", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { events: [{ event_type: "unblinding_executed" }] } });
    const resp = await client.history("NCT12345678");
    expect(resp.events[0]!.event_type).toBe("unblinding_executed");
    expect(getFn.mock.calls[0]![0]).toBe("/v1/clinical-unblind/history");
  });
});

describe("makeClinicalTrialsClient — writes", () => {
  it("blind() posts to /blind", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { blind: TRIAL } });
    const resp = await client.blind({
      trial_id: "NCT12345678",
      trial_name: "Phase III",
      phase: "phase_3",
      blinding_type: "double_blind",
      randomization_code_hash: "b".repeat(64),
      established_by: "pi",
      reason: "Trial start",
    });
    expect(resp.blind.trial_id).toBe("NCT12345678");
    expect(postFn.mock.calls[0]![0]).toBe("/v1/clinical-unblind/blind");
  });

  it("requestUnblind() posts to /unblind", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { success: true, trial_id: "NCT12345678", status: "unblinded" } });
    const resp = await client.requestUnblind({
      trial_id: "NCT12345678",
      actor_id: "pi",
      reason: "DSMB",
      approval_meaning: "I authorize the unblinding of NCT12345678.",
    });
    expect(resp.success).toBe(true);
    expect(postFn.mock.calls[0]![0]).toBe("/v1/clinical-unblind/unblind");
  });

  it("emergencyUnblind() posts to /emergency", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { success: true, trial_id: "NCT12345678", subject_id: "S-7" } });
    const resp = await client.emergencyUnblind({
      trial_id: "NCT12345678",
      actor_id: "dr",
      subject_id: "S-7",
      emergency_justification: "SAE",
    });
    expect(resp.subject_id).toBe("S-7");
    expect(postFn.mock.calls[0]![0]).toBe("/v1/clinical-unblind/emergency");
  });

  it("verifyPermit() posts to /verify-permit and returns the raw result", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { valid: true, outcome: "verified" } });
    const result = await client.verifyPermit({
      trial_id: "NCT12345678",
      permit_token: "pt.v3.abc",
      action_type: "trial.unblinding.execute",
      actor_id: "pi",
    });
    expect(result.valid).toBe(true);
    const [path, body] = postFn.mock.calls[0]!;
    expect(path).toBe("/v1/clinical-unblind/verify-permit");
    expect((body as { permit_token: string }).permit_token).toBe("pt.v3.abc");
  });
});
