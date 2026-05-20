import { describe, expect, it } from "vitest";

import { AtlaSentError } from "../src/errors.js";

describe("AtlaSentError", () => {
  it("exposes flat properties and standard name", () => {
    const err = new AtlaSentError("nope", {
      status: 429,
      code: "rate_limited",
      requestId: "req_abc",
      retryAfterMs: 1500,
    });
    expect(err.name).toBe("AtlaSentError");
    expect(err.message).toBe("nope");
    expect(err.status).toBe(429);
    expect(err.code).toBe("rate_limited");
    expect(err.requestId).toBe("req_abc");
    expect(err.retryAfterMs).toBe(1500);
  });

  it("forwards `cause` to the Error constructor (ES2022)", () => {
    const inner = new Error("original");
    const err = new AtlaSentError("wrapper", { cause: inner });
    expect(err.cause).toBe(inner);
  });

  it("is an instance of Error", () => {
    const err = new AtlaSentError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AtlaSentError);
  });

  it("leaves optional fields undefined when not provided", () => {
    const err = new AtlaSentError("x");
    expect(err.status).toBeUndefined();
    expect(err.code).toBeUndefined();
    expect(err.requestId).toBeUndefined();
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });
});

import { AtlaSentDeniedError, AtlaSentEscalateError, PermitRevoked } from "../src/errors.js";

describe("AtlaSentEscalateError", () => {
  it("has decision='escalate' and name='AtlaSentEscalateError'", () => {
    const err = new AtlaSentEscalateError("escalation required");
    expect(err.name).toBe("AtlaSentEscalateError");
    expect(err.decision).toBe("escalate");
    expect(err.message).toBe("escalation required");
    expect(err.userId).toBeUndefined();
  });

  it("stores userId from opts", () => {
    const err = new AtlaSentEscalateError("escalate", { userId: "user-1" });
    expect(err.userId).toBe("user-1");
  });

  it("forwards requestId and cause", () => {
    const cause = new Error("inner");
    const err = new AtlaSentEscalateError("escalate", { requestId: "req_1", cause });
    expect(err.requestId).toBe("req_1");
    expect(err.cause).toBe(cause);
  });

  it("is an instance of AtlaSentError and Error", () => {
    const err = new AtlaSentEscalateError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AtlaSentEscalateError);
  });
});

describe("PermitRevoked", () => {
  it("sets permitId and message without revocationId", () => {
    const err = new PermitRevoked("permit-1");
    expect(err.name).toBe("PermitRevoked");
    expect(err.permitId).toBe("permit-1");
    expect(err.revocationId).toBeUndefined();
    expect(err.message).toContain("permit-1");
    expect(err.message).toContain("revoked");
  });

  it("includes revocationId in message when provided", () => {
    const err = new PermitRevoked("permit-2", "rev-42");
    expect(err.revocationId).toBe("rev-42");
    expect(err.message).toContain("rev-42");
    expect(err.message).toContain("permit-2");
  });

  it("is an instance of AtlaSentError and Error", () => {
    const err = new PermitRevoked("p");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PermitRevoked);
  });
});
