import { describe, expect, it, vi } from "vitest";
import { Enforce } from "../../src/index.js";
import { buildMockClient, loadFixture } from "./harness.js";

const fx = loadFixture("SIM-09");
const exp = (fx as unknown as { expected: { allow_count: number; deny_count: number; deny_reason_code: string; execute_call_count: number } }).expected;

describe(fx.title, () => {
  it("allows exactly one concurrent run and denies the other with permit_consumed", async () => {
    // Both instances share the same mock client so the sequence counter is shared
    const { client } = buildMockClient(fx.mocks.evaluate, fx.mocks.verify_permit);

    const execute = vi.fn(async () => "executed");

    const enforceA = new Enforce({
      client,
      bindings: {
        orgId: fx.enforce_config.bindings.org_id,
        actorId: fx.enforce_config.bindings.actor_id,
        actionType: fx.enforce_config.bindings.action_type,
      },
      failClosed: true,
    });
    const enforceB = new Enforce({
      client,
      bindings: {
        orgId: fx.enforce_config.bindings.org_id,
        actorId: fx.enforce_config.bindings.actor_id,
        actionType: fx.enforce_config.bindings.action_type,
      },
      failClosed: true,
    });

    const [r1, r2] = await Promise.all([
      enforceA.run({ request: fx.request, execute }),
      enforceB.run({ request: fx.request, execute }),
    ]);

    const decisions = [r1.decision, r2.decision];
    expect(decisions.filter((d) => d === "allow")).toHaveLength(exp.allow_count);
    expect(decisions.filter((d) => d === "deny")).toHaveLength(exp.deny_count);

    const denyResult = [r1, r2].find((r) => r.decision === "deny")!;
    expect((denyResult as { reasonCode: string }).reasonCode).toBe(exp.deny_reason_code);

    expect(execute).toHaveBeenCalledTimes(exp.execute_call_count);
  });
});
