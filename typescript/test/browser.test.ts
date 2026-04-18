import { afterEach, describe, expect, it, vi } from "vitest";

import { AtlaSentClient as BrowserClient } from "../src/browser.js";
import { AtlaSentError } from "../src/errors.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubBrowser(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (test)" });
}

describe("browser AtlaSentClient", () => {
  it("rejects ask_live_* secret keys in a browser context", () => {
    stubBrowser();
    expect(() => new BrowserClient({ apiKey: "ask_live_xyz" })).toThrow(
      AtlaSentError,
    );
  });

  it("rejects ask_test_* secret keys in a browser context", () => {
    stubBrowser();
    expect(() => new BrowserClient({ apiKey: "ask_test_xyz" })).toThrow(
      AtlaSentError,
    );
  });

  it("rejects sk_* secret keys in a browser context", () => {
    stubBrowser();
    expect(() => new BrowserClient({ apiKey: "sk_xyz" })).toThrow(
      AtlaSentError,
    );
  });

  it("allows secret keys when allowBrowser: true", () => {
    stubBrowser();
    expect(
      () => new BrowserClient({ apiKey: "ask_live_xyz", allowBrowser: true }),
    ).not.toThrow();
  });

  it("allows non-secret keys without allowBrowser", () => {
    stubBrowser();
    expect(() => new BrowserClient({ apiKey: "pk_publishable" })).not.toThrow();
  });

  it("allows secret keys outside browser contexts (Node/server)", () => {
    // No browser globals stubbed — running in Node.
    expect(
      () => new BrowserClient({ apiKey: "ask_live_xyz" }),
    ).not.toThrow();
  });
});
