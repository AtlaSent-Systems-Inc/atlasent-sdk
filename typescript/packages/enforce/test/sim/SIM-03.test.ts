import { describe, expect, it, vi } from "vitest";
import { Enforce } from "../../src/index.js";
import { buildMockClient, loadFixture } from "./harness.js";

const fx = loadFixture("SIM-03");

describe(fx.title, () => {
  it("denies with binding_mismatch when permit actor_id does not match bindings", async () => {
    const { client, tracker } = buildMockClient(fx.mocks.evaluate, fx.mocks.verify_permit);
    const execute = vi.fn(async () => "unreachable");
    const enforce = new Enforce({
      client,
      bindings: {
        orgId: fx.enforce_config.bindings.org_id,
        actorId: fx.enforce_config.bindings.actor_id,   // actor_B
        actionType: fx.enforce_config.bindings.action_type,
      },
      failClosed: true,
    });

    const result = await enforce.run({ request: fx.request, execute });

    expect(result.decision).toBe("deny");
    expect((result as { reasonCode: string }).reasonCode).toBe("binding_mismatch");
    expect(execute).not.toHaveBeenCalled();
    expect(tracker.verifyCalls).toBeGreaterThan(0);
  });
});
