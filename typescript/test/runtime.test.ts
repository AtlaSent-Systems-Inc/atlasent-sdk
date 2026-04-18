import { afterEach, describe, expect, it, vi } from "vitest";

import { detectRuntime, isBrowserLike } from "../src/runtime.js";
import { SDK_VERSION } from "../src/version.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SDK_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof SDK_VERSION).toBe("string");
    expect(SDK_VERSION.length).toBeGreaterThan(0);
  });
});

describe("detectRuntime()", () => {
  it("returns node/<version> on Node", () => {
    // Sanity — vitest itself runs on Node.
    const ua = detectRuntime();
    expect(ua).toMatch(/^node\/\d+\.\d+\.\d+/);
  });

  it("prefers Bun over Node when both are present", () => {
    vi.stubGlobal("process", {
      versions: { node: "20.0.0", bun: "1.1.0" },
      version: "v20.0.0",
    });
    expect(detectRuntime()).toBe("bun/1.1.0");
  });

  it("returns deno/<version> when Deno.version.deno is present", () => {
    vi.stubGlobal("process", undefined);
    vi.stubGlobal("Deno", { version: { deno: "1.42.0" } });
    expect(detectRuntime()).toBe("deno/1.42.0");
  });

  it("returns 'browser' when only navigator.userAgent is present", () => {
    vi.stubGlobal("process", undefined);
    vi.stubGlobal("Deno", undefined);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 ..." });
    expect(detectRuntime()).toBe("browser");
  });

  it("returns 'edge' when EdgeRuntime is set", () => {
    vi.stubGlobal("process", undefined);
    vi.stubGlobal("Deno", undefined);
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("EdgeRuntime", "vercel");
    expect(detectRuntime()).toBe("edge");
  });

  it("returns 'unknown' when nothing is recognizable", () => {
    vi.stubGlobal("process", undefined);
    vi.stubGlobal("Deno", undefined);
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("EdgeRuntime", undefined);
    expect(detectRuntime()).toBe("unknown");
  });
});

describe("isBrowserLike()", () => {
  it("is false on Node", () => {
    expect(isBrowserLike()).toBe(false);
  });

  it("is true when window + document + navigator are all present", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 ..." });
    expect(isBrowserLike()).toBe(true);
  });

  it("is false when only navigator is present (e.g. Deno)", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("navigator", { userAgent: "Deno" });
    expect(isBrowserLike()).toBe(false);
  });
});
