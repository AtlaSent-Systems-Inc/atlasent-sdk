/**
 * Module-level convenience functions using a lazily-initialized
 * global client.
 *
 * Parity with the Python SDK's `atlasent.authorize`, `atlasent.gate`,
 * etc. — zero-config entry point for scripts and small apps that
 * don't want to wire up their own client instance.
 *
 * @example
 * import { configure, authorize } from "@atlasent/sdk";
 *
 * configure({ apiKey: process.env.ATLASENT_API_KEY! });
 * const result = await authorize({ agent: "a", action: "b" });
 */

import { AtlaSentClient } from "./client.js";
import { AtlaSentError } from "./errors.js";
import type {
  AtlaSentClientOptions,
  AuthorizationResult,
  AuthorizeRequest,
  EvaluateRequest,
  EvaluateResponse,
  GateResult,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./types.js";

let defaultClient: AtlaSentClient | undefined;

/**
 * Configure the module-level default client. Call this once at
 * startup, or rely on the `ATLASENT_API_KEY` environment variable.
 */
export function configure(options: AtlaSentClientOptions): void {
  defaultClient = new AtlaSentClient(options);
}

/**
 * Reset the module-level client — primarily for tests. Safe to call
 * even if {@link configure} was never invoked.
 */
export function resetDefaultClient(): void {
  defaultClient = undefined;
}

function getDefaultClient(): AtlaSentClient {
  if (defaultClient) return defaultClient;
  const envKey = typeof process !== "undefined" ? process.env.ATLASENT_API_KEY : undefined;
  if (!envKey) {
    throw new AtlaSentError(
      "No default client configured. Call configure({ apiKey }) or set ATLASENT_API_KEY.",
      { code: "invalid_api_key" },
    );
  }
  const options: AtlaSentClientOptions = { apiKey: envKey };
  const envBase = typeof process !== "undefined" ? process.env.ATLASENT_BASE_URL : undefined;
  if (envBase) options.baseUrl = envBase;
  defaultClient = new AtlaSentClient(options);
  return defaultClient;
}

/** Evaluate an action using the module-level default client. */
export async function evaluate(
  input: EvaluateRequest,
): Promise<EvaluateResponse> {
  return getDefaultClient().evaluate(input);
}

/** Verify a permit using the module-level default client. */
export async function verifyPermit(
  input: VerifyPermitRequest,
): Promise<VerifyPermitResponse> {
  return getDefaultClient().verifyPermit(input);
}

/** Gate (evaluate + verify) using the module-level default client. */
export async function gate(input: EvaluateRequest): Promise<GateResult> {
  return getDefaultClient().gate(input);
}

/** Authorize using the module-level default client. */
export async function authorize(
  input: AuthorizeRequest,
): Promise<AuthorizationResult> {
  return getDefaultClient().authorize(input);
}
