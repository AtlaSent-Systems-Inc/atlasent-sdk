/**
 * Browser entrypoint.
 *
 * Re-exports the public surface, but wraps the `AtlaSentClient`
 * constructor so it fails fast if a secret-style API key is passed
 * in a browser-like environment. AtlaSent secret keys are intended
 * for server-side use; shipping one to the browser exposes it to
 * every visitor.
 *
 * If you genuinely need browser usage (e.g. a trusted internal
 * dashboard already gated by SSO) and have a publishable-style key,
 * pass `{ allowBrowser: true }`.
 */

import { AtlaSentClient as NodeClient } from "./client.js";
import { AtlaSentError } from "./errors.js";
import { isBrowserLike } from "./runtime.js";
import type { AtlaSentClientOptions } from "./types.js";

export interface BrowserClientOptions extends AtlaSentClientOptions {
  /** Bypass the browser-secret-key check. Use only with non-secret keys. */
  allowBrowser?: boolean;
}

const SECRET_KEY_PREFIXES = ["ask_live_", "ask_test_", "sk_"];

export class AtlaSentClient extends NodeClient {
  constructor(options: BrowserClientOptions) {
    if (
      isBrowserLike() &&
      !options.allowBrowser &&
      typeof options.apiKey === "string" &&
      SECRET_KEY_PREFIXES.some((p) => options.apiKey.startsWith(p))
    ) {
      throw new AtlaSentError(
        "Refusing to use a secret AtlaSent API key in a browser. " +
          "Secret keys (ask_live_*, ask_test_*, sk_*) must stay server-side. " +
          "If you have a non-secret key and accept the risk, pass { allowBrowser: true }.",
        { code: "invalid_api_key" },
      );
    }
    super(options);
  }
}

export {
  AtlaSentError,
  type AtlaSentErrorCode,
  type AtlaSentErrorInit,
} from "./errors.js";
export type {
  AtlaSentClientOptions,
  Decision,
  EvaluateRequest,
  EvaluateResponse,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./types.js";
