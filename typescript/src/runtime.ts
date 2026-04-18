/**
 * Runtime detection helpers.
 *
 * The SDK runs on Node, Bun, Deno, edge runtimes (Workers, Vercel
 * Edge), and modern browsers. `process.version` only exists on Node,
 * so the User-Agent must be assembled defensively.
 */

interface ProcessLike {
  versions?: { node?: string; bun?: string };
  version?: string;
}

interface DenoLike {
  version?: { deno?: string };
}

interface NavigatorLike {
  userAgent?: string;
}

/**
 * Returns a short string identifying the current JS runtime, suitable
 * for embedding in a User-Agent header. Examples:
 *
 *   "node/20.11.1"
 *   "bun/1.1.0"
 *   "deno/1.42.0"
 *   "edge"      (no recognizable runtime, but no DOM either)
 *   "browser"   (a navigator.userAgent is present)
 *   "unknown"
 */
export function detectRuntime(): string {
  const g = globalThis as Record<string, unknown>;

  const proc = g.process as ProcessLike | undefined;
  const bunVersion = proc?.versions?.bun;
  if (bunVersion) return `bun/${bunVersion}`;

  const nodeVersion = proc?.versions?.node ?? proc?.version?.replace(/^v/, "");
  if (nodeVersion) return `node/${nodeVersion}`;

  const deno = g.Deno as DenoLike | undefined;
  const denoVersion = deno?.version?.deno;
  if (denoVersion) return `deno/${denoVersion}`;

  const nav = g.navigator as NavigatorLike | undefined;
  if (typeof nav?.userAgent === "string" && nav.userAgent.length > 0) {
    return "browser";
  }

  if (typeof g.EdgeRuntime === "string" || g.EdgeRuntime === true) {
    return "edge";
  }

  return "unknown";
}

/**
 * Returns true if the current runtime is a browser-like environment
 * where shipping a secret API key would expose it to end users.
 *
 * Used by the browser entrypoint to fail fast on `ask_live_*` /
 * `ask_test_*` keys.
 */
export function isBrowserLike(): boolean {
  const g = globalThis as Record<string, unknown>;
  const nav = g.navigator as NavigatorLike | undefined;
  const hasWindow = typeof g.window !== "undefined";
  const hasDocument = typeof g.document !== "undefined";
  const hasNavigator = typeof nav?.userAgent === "string";
  return hasWindow && hasDocument && hasNavigator;
}
