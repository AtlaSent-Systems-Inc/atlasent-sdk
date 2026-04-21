import { describe, expect, it } from "vitest";

import { AtlaSentError, fromEnv } from "../src/index.js";

describe("fromEnv", () => {
  it("throws when ATLASENT_API_KEY is missing (default behavior)", () => {
    expect(() => fromEnv({ env: {} })).toThrow(AtlaSentError);
    expect(() => fromEnv({ env: { ATLASENT_API_KEY: "" } })).toThrow(AtlaSentError);
  });

  it("returns { apiKey: '' } when requireApiKey is false and the key is missing", () => {
    const result = fromEnv({ env: {}, requireApiKey: false });
    expect(result.apiKey).toBe("");
  });

  it("reads ATLASENT_API_KEY and ATLASENT_BASE_URL", () => {
    const result = fromEnv({
      env: {
        ATLASENT_API_KEY: "ask_live_xyz",
        ATLASENT_BASE_URL: "https://staging.atlasent.io",
      },
    });
    expect(result.apiKey).toBe("ask_live_xyz");
    expect(result.baseUrl).toBe("https://staging.atlasent.io");
  });

  it("prefers ATLASENT_TIMEOUT_MS when both are set (explicit wins)", () => {
    const result = fromEnv({
      env: {
        ATLASENT_API_KEY: "k",
        ATLASENT_TIMEOUT: "5", // would be 5000ms via Python heuristic
        ATLASENT_TIMEOUT_MS: "7500",
      },
    });
    expect(result.timeoutMs).toBe(7500);
  });

  it("treats small ATLASENT_TIMEOUT as seconds (Python-compatible)", () => {
    const result = fromEnv({
      env: { ATLASENT_API_KEY: "k", ATLASENT_TIMEOUT: "10" },
    });
    expect(result.timeoutMs).toBe(10_000);
  });

  it("treats large ATLASENT_TIMEOUT as milliseconds", () => {
    const result = fromEnv({
      env: { ATLASENT_API_KEY: "k", ATLASENT_TIMEOUT: "15000" },
    });
    expect(result.timeoutMs).toBe(15_000);
  });

  it("reads ATLASENT_MAX_RETRIES as an integer", () => {
    const result = fromEnv({
      env: { ATLASENT_API_KEY: "k", ATLASENT_MAX_RETRIES: "5" },
    });
    expect(result.maxRetries).toBe(5);
  });

  it("reads ATLASENT_RETRY_BACKOFF via the dual-unit heuristic", () => {
    expect(
      fromEnv({
        env: { ATLASENT_API_KEY: "k", ATLASENT_RETRY_BACKOFF: "0.5" },
      }).retryBackoffMs,
    ).toBe(500);
    expect(
      fromEnv({
        env: { ATLASENT_API_KEY: "k", ATLASENT_RETRY_BACKOFF: "2000" },
      }).retryBackoffMs,
    ).toBe(2000);
  });

  it("throws on a non-numeric duration", () => {
    expect(() =>
      fromEnv({ env: { ATLASENT_API_KEY: "k", ATLASENT_TIMEOUT: "soon" } }),
    ).toThrow(/Invalid ATLASENT_TIMEOUT/);
  });

  it("throws on a negative count", () => {
    expect(() =>
      fromEnv({ env: { ATLASENT_API_KEY: "k", ATLASENT_MAX_RETRIES: "-1" } }),
    ).toThrow(/Invalid ATLASENT_MAX_RETRIES/);
  });

  it("omits unset optional keys so class defaults apply", () => {
    const result = fromEnv({ env: { ATLASENT_API_KEY: "k" } });
    expect(result.baseUrl).toBeUndefined();
    expect(result.timeoutMs).toBeUndefined();
    expect(result.maxRetries).toBeUndefined();
    expect(result.retryBackoffMs).toBeUndefined();
  });
});
