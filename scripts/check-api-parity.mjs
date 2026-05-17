#!/usr/bin/env node
// Check SDK <-> API parity per docs/api-parity.md and V1_GATES.md G4.
//
// - Scans typescript/src/ and python/atlasent_sdk/ for `@hitl-method <slug>`
//   annotations (// or # comment style).
// - Parses the matrix block in docs/api-parity.md for registered slugs.
// - Fails the build if a source annotation has no matrix row, or if a row
//   is marked `status: absent` but live annotations exist.
//
// Designed to be slow-path safe: O(files), no SDK build required.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PATH = join(REPO_ROOT, "docs", "api-parity.md");

const TS_SOURCE_DIRS = [join(REPO_ROOT, "typescript", "src")];
const PY_SOURCE_DIRS = [join(REPO_ROOT, "python", "atlasent_sdk")];

const ANNOTATION_RE = /(?:\/\/|#)\s*@hitl-method\s+([a-zA-Z0-9._:-]+)/g;

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "__pycache__" || name.startsWith(".")) continue;
      out.push(...walk(p));
    } else if (st.isFile() && /\.(ts|tsx|mts|cts|py)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function collectAnnotations(dirs) {
  const found = new Map(); // slug -> ["path:line", ...]
  for (const root of dirs) {
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      let m;
      ANNOTATION_RE.lastIndex = 0;
      while ((m = ANNOTATION_RE.exec(src)) !== null) {
        const slug = m[1];
        const line = src.slice(0, m.index).split("\n").length;
        const rel = file.slice(REPO_ROOT.length + 1);
        if (!found.has(slug)) found.set(slug, []);
        found.get(slug).push(`${rel}:${line}`);
      }
    }
  }
  return found;
}

function parseMatrix(matrixSrc) {
  // Slug -> { status }. Parses both registry blocks (TS + Python).
  const rows = new Map();
  const blockRe = /<!--\s*(?:registry|python-registry)-start\s*-->([\s\S]*?)<!--\s*(?:registry|python-registry)-end\s*-->/g;
  const rowRe = /^\|\s*([^|_][^|]*?)\s*\|[^|]*\|[^|]*\|\s*([a-z]+)\s*\|/gm;
  let block;
  while ((block = blockRe.exec(matrixSrc)) !== null) {
    const content = block[1];
    let row;
    while ((row = rowRe.exec(content)) !== null) {
      const slug = row[1].trim();
      const status = row[2].trim();
      if (slug && slug !== "Slug" && !slug.startsWith("-")) {
        rows.set(slug, { status });
      }
    }
  }
  return rows;
}

function main() {
  let matrixSrc;
  try {
    matrixSrc = readFileSync(MATRIX_PATH, "utf8");
  } catch (e) {
    console.error(`[api-parity] cannot read ${MATRIX_PATH}: ${e.message}`);
    process.exit(2);
  }

  const registry = parseMatrix(matrixSrc);
  const tsHits = collectAnnotations(TS_SOURCE_DIRS);
  const pyHits = collectAnnotations(PY_SOURCE_DIRS);
  const allHits = new Map();
  for (const [slug, locs] of tsHits) allHits.set(slug, locs);
  for (const [slug, locs] of pyHits) {
    const prev = allHits.get(slug) ?? [];
    allHits.set(slug, [...prev, ...locs]);
  }

  const failures = [];

  for (const [slug, locs] of allHits) {
    const row = registry.get(slug);
    if (!row) {
      failures.push(
        `unregistered slug "${slug}" found in:\n  - ${locs.join("\n  - ")}\n` +
          `  Add a row to docs/api-parity.md (TS or Python registry block).`,
      );
      continue;
    }
    if (row.status === "absent") {
      failures.push(
        `slug "${slug}" is marked status=absent in docs/api-parity.md but ` +
          `live annotations exist:\n  - ${locs.join("\n  - ")}\n` +
          `  Ship the API handler and update status to ga|alpha, or remove ` +
          `the @hitl-method annotation(s).`,
      );
    }
  }

  if (failures.length) {
    console.error("[api-parity] FAIL\n");
    for (const f of failures) console.error(f + "\n");
    process.exit(1);
  }

  console.log(
    `[api-parity] OK — ${allHits.size} annotated slug(s); ${registry.size} matrix row(s).`,
  );
}

main();
