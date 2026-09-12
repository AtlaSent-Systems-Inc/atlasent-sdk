/**
 * Regression guard for the trust-root vendoring incident (see
 * trustRoot.ts's header, and the "Fixed" CHANGELOG entry it links to).
 *
 * trustRoot.ts previously imported `node:fs`/`node:url`/`node:path` to read
 * a vendored snapshot from disk at runtime — a static ESM import that any
 * browser bundler (Vite/Rollup/webpack) tries to resolve at build time
 * regardless of whether the code path importing it ever actually runs in
 * that environment, breaking the build for any browser consumer of this
 * SDK's main entry. The fix replaced the runtime file read with a
 * build-time-embedded object literal (vendoredTrustRoot.generated.ts), so
 * trustRoot.ts now has zero imports of its own.
 *
 * This guard fails loudly if either file regains a Node-builtin import,
 * so the defect can't quietly come back the same way it arrived — a
 * seemingly-safe "just read this one extra vendor file" edit.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, "..", "src");

// Matches `import ... from "node:fs"` / `from "fs"` (bare or `node:`-prefixed)
// and the equivalent for path/url, plus dynamic `import("node:fs")` etc.
const NODE_BUILTIN_IMPORT_RE =
  /\b(?:import\s[^;]*\bfrom\s*|import\s*\(\s*)["'](?:node:)?(fs|path|url)(?:\/[^"']*)?["']/g;

const FILES_MUST_STAY_NODE_FREE = ["trustRoot.ts", "vendoredTrustRoot.generated.ts"];

describe("trust-root browser-bundling safety", () => {
  for (const filename of FILES_MUST_STAY_NODE_FREE) {
    it(`${filename} has no node:fs/node:path/node:url import`, () => {
      const source = readFileSync(resolve(SRC_DIR, filename), "utf8");
      const matches = [...source.matchAll(NODE_BUILTIN_IMPORT_RE)].map((m) => m[0]);
      expect(matches).toEqual([]);
    });
  }

  it("the guard itself catches a real Node-builtin import (mutation check)", () => {
    const mutated = `import { readFileSync } from "node:fs";\nexport const x = 1;\n`;
    const matches = [...mutated.matchAll(NODE_BUILTIN_IMPORT_RE)].map((m) => m[0]);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("the guard tolerates an unrelated import (no false positive)", () => {
    const clean = `import { VENDORED_TRUST_ROOT_SNAPSHOT } from "./vendoredTrustRoot.generated.js";\n`;
    const matches = [...clean.matchAll(NODE_BUILTIN_IMPORT_RE)].map((m) => m[0]);
    expect(matches).toEqual([]);
  });
});
