import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { defineConfig } from "tsup";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "package.json"), "utf8"),
) as { version: string };

const define = {
  __SDK_VERSION__: JSON.stringify(pkg.version),
};

export default defineConfig([
  // Default (Node) build — `process`, `node:` imports allowed.
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    target: "node20",
    platform: "node",
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    minify: false,
    define,
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  // Browser / edge / Deno build — no Node built-ins, smaller, ESM-only,
  // browser-safe constructor enforced via the `browser.ts` entry.
  {
    entry: { browser: "src/browser.ts" },
    format: ["esm"],
    target: "es2022",
    platform: "neutral",
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
    minify: false,
    define,
  },
]);
