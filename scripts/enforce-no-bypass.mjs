#!/usr/bin/env node
/**
 * enforce-no-bypass — static lint for the @atlasent/enforce package.
 *
 * Rejects any TypeScript/JavaScript source file that:
 *   1. Imports from "@atlasent/sdk" directly (disallowed inside the enforce package source)
 *   2. Calls .evaluate( on a client instance directly (bypassing Enforce.run)
 *
 * Usage:
 *   node scripts/enforce-no-bypass.mjs [file-or-glob ...]
 *
 * Exit codes:
 *   0 — no violations
 *   1 — one or more violations found
 *
 * In CI, run against the enforce package src:
 *   node scripts/enforce-no-bypass.mjs typescript/packages/enforce/src/**\/*.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const RULE_NAME = "enforce-no-bypass";

const PATTERNS = [
  {
    re: /from\s+["']@atlasent\/sdk["']/,
    message: "Direct import from @atlasent/sdk is not allowed inside the Enforce package. Use EnforceCompatibleClient interface instead.",
  },
  {
    re: /\bAtlasentClient\b/,
    message: "Direct use of AtlasentClient is not allowed inside the Enforce package source. Inject via EnforceCompatibleClient.",
  },
  {
    re: /\.evaluate\s*\(/,
    message: "Direct call to .evaluate() is not allowed outside the Enforce wrapper. Route all evaluation through Enforce.run().",
  },
];

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error(`[${RULE_NAME}] No files specified. Pass one or more file paths as arguments.`);
  process.exit(1);
}

let violations = 0;

for (const rawPath of files) {
  const filePath = resolve(rawPath);
  let source;
  try {
    source = readFileSync(filePath, "utf-8");
  } catch {
    console.error(`[${RULE_NAME}] Cannot read file: ${filePath}`);
    violations++;
    continue;
  }

  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Per-line pragma: // enforce-no-bypass: allow
    if (/enforce-no-bypass:\s*allow/.test(line)) continue;
    for (const { re, message } of PATTERNS) {
      if (re.test(line)) {
        console.error(
          `[${RULE_NAME}] ${filePath}:${i + 1}: ${message}\n  > ${line.trim()}`,
        );
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(
    `\n[${RULE_NAME}] ${violations} violation(s) found. Fix them before merging.`,
  );
  process.exit(1);
}

console.log(`[${RULE_NAME}] OK — no violations found in ${files.length} file(s).`);
process.exit(0);
