/**
 * Structured logging interface.
 *
 * Every log call carries a small `Record<string, unknown>` of
 * structured fields so consumers can route to pino / winston /
 * console / Datadog / etc. without string parsing. The default is a
 * {@link noopLogger} that drops everything; users who want visibility
 * pass their own implementation on the client.
 *
 * Parity with Python: mirrors the structured-field calls made by
 * `atlasent.client` / `atlasent.async_client` (evaluate/verify/gate,
 * retries, cache hits, request IDs).
 */

/** Minimal structured-logger interface consumed by {@link AtlaSentClient}. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Drops every log line — the default when no logger is injected. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Console-backed logger that emits JSON lines to `console.error`
 * (stderr). Useful for local development and as a CLI default.
 */
export const consoleLogger: Logger = {
  debug: (message, fields) => emit("debug", message, fields),
  info: (message, fields) => emit("info", message, fields),
  warn: (message, fields) => emit("warn", message, fields),
  error: (message, fields) => emit("error", message, fields),
};

function emit(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown> | undefined,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    logger: "atlasent",
    msg: message,
    ...(fields ?? {}),
  });
  // Stderr keeps stdout clean for programs that pipe data out.
  console.error(line);
}
