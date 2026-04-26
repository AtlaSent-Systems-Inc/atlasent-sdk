/**
 * Public-export smoke test. Guards against an `index.ts` typo or a
 * missing re-export; runtime behaviour is covered by
 * `withSentry.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/core", () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

import * as pkg from "../src/index.js";

describe("@atlasent/sentry-preview public exports", () => {
  it("re-exports withSentry and wrapProtect", () => {
    expect(typeof pkg.withSentry).toBe("function");
    expect(typeof pkg.wrapProtect).toBe("function");
  });
});
