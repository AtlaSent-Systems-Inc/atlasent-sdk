import { describe, expect, it, vi } from "vitest";
import { Enforce } from "../../src/index.js";
import { buildMockClient, loadFixture } from "./harness.js";

const fx = loadFixture("SIM-02");

describe(fx.title, () => {
  it("denies with permit_expired when verifyPermit rejects on TTL", async () => {
    const { client, verifyCalls } = buildMockClient(fx.mocks.evaluate, fx.mocks.verify_permit);
    const execute = vi.fn(async () => "unreachable");
    const enforce = new Enforce({
      client,
      bindings: {
        orgId: fx.enforce_config.bindings.org_id,
        actorId: fx.enforce_config.bindings.actor_id,
        actionType: fx.enforce_config.bindings.action_type,
      },
      failClosed: true,
    });

    const result = await enforce.run({ request: fx.request, execute });

    expect(result.decision).toBe("deny");
    expect((result as { reasonCode: string }).reasonCode).toBe("permit_expired");
    expect(execute).not.toHaveBeenCalled();
    expect(verifyCalls).toBeGreaterThan(0);
  });
});
