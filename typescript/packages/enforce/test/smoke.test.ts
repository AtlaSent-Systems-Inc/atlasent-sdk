import { describe, expect, it } from "vitest";
import {
  DisallowedConfigError,
  Enforce,
  NotImplementedError,
  type EnforceCompatibleClient,
} from "../src/index.js";

const stubClient: EnforceCompatibleClient = {
  async evaluate() {
    throw new Error("stub");
  },
  async verifyPermit() {
    throw new Error("stub");
  },
};

const bindings = {
  orgId: "org_test",
  actorId: "actor_test",
  actionType: "deploy",
};

describe("Enforce skeleton", () => {
  it("constructs with failClosed: true", () => {
    const enforce = new Enforce({
      client: stubClient,
      bindings,
      failClosed: true,
    });
    expect(enforce).toBeInstanceOf(Enforce);
  });

  it("throws DisallowedConfigError when failClosed is not true", () => {
    expect(
      () =>
        new Enforce({
          client: stubClient,
          bindings,
          // @ts-expect-error — invariant 2: failClosed is non-toggleable
          failClosed: false,
        }),
    ).toThrow(DisallowedConfigError);
  });

  it("run() throws NotImplementedError until SIM-01..SIM-10 land", async () => {
    const enforce = new Enforce({
      client: stubClient,
      bindings,
      failClosed: true,
    });
    await expect(
      enforce.run({
        request: {},
        execute: async () => "unreachable",
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});
