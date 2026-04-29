export class DisallowedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisallowedConfigError";
  }
}

/** Thrown internally when the latency budget is breached in deny mode. */
export class LatencyBreachSignal extends Error {
  constructor() {
    super("verify_latency_breach");
    this.name = "LatencyBreachSignal";
  }
}

/**
 * Inspect an error thrown by a client method and return the appropriate
 * ReasonCode. Falls back to the given default if no specific code is found.
 */
export function classifyClientError(
  err: unknown,
  fallback: string,
): string {
  if (err instanceof Error) {
    const rc = (err as { reasonCode?: unknown }).reasonCode;
    if (typeof rc === "string" && rc.length > 0) return rc;

    const status = (err as { httpStatus?: unknown }).httpStatus;
    if (typeof status === "number") {
      return status >= 400 && status < 500 ? `${fallback.replace("_unavailable", "_client_error")}` : fallback;
    }
  }
  return fallback;
}
