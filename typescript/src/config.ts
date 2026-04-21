/**
 * Environment-variable configuration for the default client.
 *
 * Parity with Python's `atlasent.config`: the same env-var names
 * (`ATLASENT_API_KEY`, `ATLASENT_BASE_URL`, `ATLASENT_TIMEOUT`,
 * `ATLASENT_MAX_RETRIES`) resolve to the same client fields, so
 * the two SDKs honor a shared `.env`.
 */

import { AtlaSentError } from "./errors.js";
import type { AtlaSentClientOptions } from "./types.js";

export interface FromEnvOptions {
  /**
   * The env object to read from. Defaults to `process.env` — pass a
   * plain record for tests or sandboxed environments.
   */
  env?: Record<string, string | undefined>;
  /**
   * If `true`, throws when `ATLASENT_API_KEY` is unset. Defaults to
   * `true` — set `false` to get a partial config with `apiKey: ""`.
   */
  requireApiKey?: boolean;
}

/**
 * Build an {@link AtlaSentClientOptions} object from environment
 * variables.
 *
 * Recognized:
 * - `ATLASENT_API_KEY`       → `apiKey` (required unless requireApiKey: false)
 * - `ATLASENT_BASE_URL`      → `baseUrl`
 * - `ATLASENT_TIMEOUT`       → `timeoutMs` (Python uses seconds; accepts
 *                              either — integers ≤ 600 treated as seconds,
 *                              larger values as milliseconds)
 * - `ATLASENT_TIMEOUT_MS`    → `timeoutMs` (explicit, preferred)
 * - `ATLASENT_MAX_RETRIES`   → `maxRetries`
 * - `ATLASENT_RETRY_BACKOFF` → `retryBackoffMs` (seconds in Python;
 *                              same dual-unit heuristic as timeout)
 */
export function fromEnv(options: FromEnvOptions = {}): AtlaSentClientOptions {
  const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
  const requireApiKey = options.requireApiKey ?? true;

  const apiKey = env.ATLASENT_API_KEY ?? "";
  if (!apiKey && requireApiKey) {
    throw new AtlaSentError(
      "ATLASENT_API_KEY is not set. Export it, pass { apiKey } to new AtlaSentClient(), or call configure().",
      { code: "invalid_api_key" },
    );
  }

  const out: AtlaSentClientOptions = { apiKey };

  const baseUrl = env.ATLASENT_BASE_URL;
  if (baseUrl) out.baseUrl = baseUrl;

  const timeoutMs = readTimeout(env.ATLASENT_TIMEOUT_MS, env.ATLASENT_TIMEOUT);
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;

  const maxRetries = readInt(env.ATLASENT_MAX_RETRIES, "ATLASENT_MAX_RETRIES");
  if (maxRetries !== undefined) out.maxRetries = maxRetries;

  const retryBackoffMs = readDurationMs(
    env.ATLASENT_RETRY_BACKOFF,
    "ATLASENT_RETRY_BACKOFF",
  );
  if (retryBackoffMs !== undefined) out.retryBackoffMs = retryBackoffMs;

  return out;
}

/**
 * Accepts either `ATLASENT_TIMEOUT_MS` (explicit) or `ATLASENT_TIMEOUT`
 * (Python-compatible). A bare `ATLASENT_TIMEOUT` below 600 is treated
 * as seconds, matching Python's `DEFAULT_TIMEOUT = 10`; anything
 * larger is treated as milliseconds.
 */
function readTimeout(
  rawMs: string | undefined,
  rawUnknown: string | undefined,
): number | undefined {
  if (rawMs !== undefined) return readInt(rawMs, "ATLASENT_TIMEOUT_MS");
  return readDurationMs(rawUnknown, "ATLASENT_TIMEOUT");
}

function readDurationMs(
  raw: string | undefined,
  name: string,
): number | undefined {
  const n = readInt(raw, name);
  if (n === undefined) return undefined;
  return n <= 600 ? n * 1000 : n;
}

function readInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new AtlaSentError(
      `Invalid ${name}: ${raw}. Expected a non-negative number.`,
      { code: "bad_request" },
    );
  }
  return n;
}
