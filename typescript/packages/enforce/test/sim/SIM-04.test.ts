import { describe, expect, it, vi } from "vitest";
import { Enforce } from "../../src/index.js";
import { buildMockClient, loadFixture } from "./harness.js";

const fx = loadFixture("SIM-04");

describe(fx.title, () => {
  it("allows first run and denies replay with permit_consumed", async () => {
    const { client } = buildMockClient(fx.mocks.evaluate, fx.mocks.verify_permit);
    const execute = vi.fn(async (_permit: unknown) => "executed");
    const enforce = new Enforce({
      client,
      bindings: {
        orgId: fx.enforce_config.bindings.org_id,
        actorId: fx.enforce_config.bindings.actor_id,
        actionType: fx.enforce_config.bindings.action_type,
      },
      failClosed: true,
    });

    const phases = (fx as { expected: { phases: Array<{ decision: string; reason_code?: string | null; execute_called: boolean }> } }).expected.phases;

    // Phase 1 — first run
    const result1 = await enforce.run({ request: fx.request, execute });
    expect(result1.decision).toBe(phases[0]!.decision);
    expect(execute).toHaveBeenCalledTimes(1);

    // Phase 2 — replay
    const result2 = await enforce.run({ request: fx.request, execute });
    expect(result2.decision).toBe(phases[1]!.decision);
    expect((result2 as { reasonCode: string }).reasonCode).toBe(phases[1]!.reason_code ?? undefined);
    expect(execute).toHaveBeenCalledTimes(1); // still 1, never re-called
  });
});
