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
