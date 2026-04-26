/**
 * Public-export smoke test. Guards against an `index.ts` typo or a
 * missing re-export; runtime behaviour is covered by
 * `withOtel.test.ts`.
 */

import { describe, expect, it } from "vitest";

import * as pkg from "../src/index.js";

describe("@atlasent/otel-preview public exports", () => {
  it("re-exports withOtel and wrapProtect", () => {
    expect(typeof pkg.withOtel).toBe("function");
    expect(typeof pkg.wrapProtect).toBe("function");
  });
});
