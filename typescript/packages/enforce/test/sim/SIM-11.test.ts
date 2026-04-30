import { describe, expect, it, vi } from "vitest";
import { Enforce } from "../../src/index.js";
import { buildMockClient, loadFixture } from "./harness.js";

const fx = loadFixture("SIM-11");

describe(fx.title, () => {
  it("denies with permit_revoked when verifyPermit reports revocation", async () => {
    const { client, tracker } = buildMockClient(fx.mocks.evaluate, fx.mocks.verify_permit);
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
    expect((result as { reasonCode: string }).reasonCode).toBe("permit_revoked");
    expect(execute).not.toHaveBeenCalled();
    expect(tracker.verifyCalls).toBeGreaterThan(0);
  });
});
