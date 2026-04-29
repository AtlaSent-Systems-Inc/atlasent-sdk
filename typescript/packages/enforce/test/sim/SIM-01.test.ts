import { describe, expect, it, vi } from "vitest";
import { Enforce } from "../../src/index.js";
import { buildMockClient, loadFixture } from "./harness.js";

const fx = loadFixture("SIM-01");

describe(fx.title, () => {
  it("passes deny decision through without calling execute or verifyPermit", async () => {
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

    expect(result.decision).toBe(fx.expected!.decision);
    expect((result as { reasonCode?: string }).reasonCode).toBe(fx.expected!.reason_code ?? undefined);
    expect(execute).not.toHaveBeenCalled();
    expect(tracker.verifyCalls).toBe(0);
  });
});
