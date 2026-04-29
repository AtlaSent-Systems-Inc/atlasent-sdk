/**
 * Public-export smoke test. Guards against an `index.ts` typo or a
 * missing re-export; runtime behaviour is covered by
 * `withAtlaSentActivity.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", () => ({
  Context: { current: () => ({ info: {} }) },
}));
vi.mock("@atlasent/sdk", () => ({ protect: vi.fn() }));

import * as pkg from "../src/index.js";

describe("@atlasent/temporal-preview public exports", () => {
  it("re-exports withAtlaSentActivity", () => {
    expect(typeof pkg.withAtlaSentActivity).toBe("function");
  });
});
