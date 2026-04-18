/**
 * SDK version.
 *
 * `__SDK_VERSION__` is replaced at build time by tsup with the
 * `version` field from package.json. In dev / test (no replacement),
 * the literal string is read so the import never throws.
 */
declare const __SDK_VERSION__: string;

export const SDK_VERSION: string =
  typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "0.0.0-dev";
