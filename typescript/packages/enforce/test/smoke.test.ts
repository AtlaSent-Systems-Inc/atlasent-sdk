import { describe, expect, it } from "vitest";
import {
  DisallowedConfigError,
  Enforce,
  type EnforceCompatibleClient,
  type EvaluateResponse,
  type VerifiedPermit,
} from "../src/index.js";

const BINDINGS = { orgId: "org_test", actorId: "actor_test", actionType: "deploy" };

const stubClient: EnforceCompatibleClient = {
  async evaluate(): Promise<EvaluateResponse> { throw new Error("stub"); },
  async verifyPermit(): Promise<VerifiedPermit> { throw new Error("stub"); },
};

describe("Enforce construction", () => {
  it("constructs with failClosed: true", () => {
    const e = new Enforce({ client: stubClient, bindings: BINDINGS, failClosed: true });
    expect(e).toBeInstanceOf(Enforce);
  });

  it("throws DisallowedConfigError when failClosed is not true", () => {
    expect(
      () => new Enforce({ client: stubClient, bindings: BINDINGS, failClosed: false as unknown as true }),
    ).toThrow(DisallowedConfigError);
  });
});
