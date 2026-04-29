import { describe, expect, it, vi } from "vitest";
import { Enforce } from "../../src/index.js";
import { buildMockClient, loadFixture } from "./harness.js";

const fx = loadFixture("SIM-06");

describe(fx.title, () => {
  for (const c of (fx as unknown as { cases: Array<{ label: string; latency_breach_mode: "deny" | "warn"; expected: { decision: string; reason_code?: string | null; execute_called: boolean; warn_emitted?: boolean } }> }).cases) {
    it(`latency_breach_mode=${c.latency_breach_mode} — ${c.label}`, async () => {
      const warnSpy = vi.fn();
      const { client } = buildMockClient(fx.mocks.evaluate, fx.mocks.verify_permit);
      const execute = vi.fn(async () => "executed");
      const enforce = new Enforce({
        client,
        bindings: {
          orgId: fx.enforce_config.bindings.org_id,
          actorId: fx.enforce_config.bindings.actor_id,
          actionType: fx.enforce_config.bindings.action_type,
        },
        failClosed: true,
        latencyBudgetMs: fx.enforce_config.latency_budget_ms,
        latencyBreachMode: c.latency_breach_mode,
        onLatencyBreach: warnSpy,
      });

      const result = await enforce.run({ request: fx.request, execute });

      expect(result.decision).toBe(c.expected.decision);
      if (c.expected.reason_code) {
        expect((result as { reasonCode: string }).reasonCode).toBe(c.expected.reason_code);
      }
      if (c.expected.execute_called) {
        expect(execute).toHaveBeenCalledOnce();
      } else {
        expect(execute).not.toHaveBeenCalled();
      }
      if (c.expected.warn_emitted) {
        expect(warnSpy).toHaveBeenCalledOnce();
      }
    });
  }
});
