#!/usr/bin/env node
// Re-vendor src/vendoredTrustRoot.generated.ts from the canonical public
// trust root published by atlasent-keys.
//
// Source of truth (in priority order):
//   1. atlasent-keys/.well-known/atlasent-trust-root.json      (issued_at / valid_until)
//      atlasent-keys/.well-known/atlasent-verifier-keys.json   (keys)
//      atlasent-keys/.well-known/atlasent-revocations.json     (revoked_keys / revoked_identities)
//   2. https://keys.atlasent.io/.well-known/<file> — same three files, live.
//
// This script only transcribes that JSON into a typed TS module — it never
// invents key material. Run it whenever atlasent-keys' trust root changes
// (a key rotation, a revocation) so the SDK's embedded baseline snapshot
// stays current; the SDK's background refresh (TrustRootManager) still
// keeps a long-running process fresh between vendoring passes.
//
// Why embedded, not read from disk at runtime (see trustRoot.ts's own
// header for the incident this closes): the previous design read
// vendor/trust-root/*.json via fs.readFileSync at first use. Those files
// were never included in the published npm package (package.json's
// `files` field never listed `vendor`), and the path-resolution math
// additionally broke under tsup's single-file bundle output — so every
// real install silently fell back to an empty, never-expiring snapshot
// (zero keys, zero revocations), and the static `node:fs`/`node:url`/
// `node:path` imports also broke bundling for any browser consumer.
// Embedding the data as a plain object literal at build time fixes both:
// no file I/O, no path guessing, and nothing Node-specific to bundle.
//
// Usage:
//   node scripts/vendor-trust-root.mjs [path/to/atlasent-keys/checkout]
// Default path assumes atlasent-keys is a sibling checkout
// (../../atlasent-keys relative to this script, i.e. a sibling of
// atlasent-sdk/). Falls back to a live fetch from keys.atlasent.io if the
// local checkout isn't found and no path was given.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(here, "..", "src", "vendoredTrustRoot.generated.ts");

const LIVE_BASE_URL = "https://keys.atlasent.io/.well-known";

async function loadThree(localDir) {
  if (localDir) {
    return {
      trustRoot: JSON.parse(readFileSync(resolve(localDir, "atlasent-trust-root.json"), "utf8")),
      verifierKeys: JSON.parse(readFileSync(resolve(localDir, "atlasent-verifier-keys.json"), "utf8")),
      revocations: JSON.parse(readFileSync(resolve(localDir, "atlasent-revocations.json"), "utf8")),
    };
  }
  const [trustRoot, verifierKeys, revocations] = await Promise.all(
    ["atlasent-trust-root.json", "atlasent-verifier-keys.json", "atlasent-revocations.json"].map(
      async (name) => {
        const res = await fetch(`${LIVE_BASE_URL}/${name}`);
        if (!res.ok) throw new Error(`fetch ${name}: ${res.status} ${res.statusText}`);
        return res.json();
      },
    ),
  );
  return { trustRoot, verifierKeys, revocations };
}

const VALID_KEY_ROLES = new Set(["R1_release", "R2_permit", "R3_audit", "R4_pack"]);

function problem(list, message) {
  list.push(message);
  return undefined;
}

function requireIsoString(value, label, problems) {
  if (typeof value !== "string" || value.length === 0 || Number.isNaN(Date.parse(value))) {
    return problem(problems, `${label} must be a parseable ISO-8601 string, got: ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNonEmptyString(value, label, problems) {
  if (typeof value !== "string" || value.length === 0) {
    return problem(problems, `${label} must be a non-empty string, got: ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalString(value, label, problems) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return problem(problems, `${label} must be a string or null/absent`);
  return value;
}

function optionalBoolean(value, label, problems) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") return problem(problems, `${label} must be a boolean or absent`);
  return value;
}

/**
 * Returns `value` as-is when it's an array; otherwise records a problem
 * and returns `[]`. Kept as one function (rather than a ternary calling
 * `problem()` inline) so the "record the problem" side effect and the
 * "what value do we use instead" fallback aren't smeared across one
 * confusing expression — CodeQL flagged exactly that shape ("useless
 * conditional") in an earlier revision of this file, correctly: `problem()`
 * always returns `undefined`, so chaining `?? []` off its call site reads
 * like a conditional whose branch never varies.
 */
function requireArray(value, label, problems) {
  if (Array.isArray(value)) return value;
  problem(problems, `${label} must be an array, got: ${typeof value}`);
  return [];
}

/**
 * Rebuild a trust-root key from untrusted input (a local file, or a live
 * fetch from keys.atlasent.io) field-by-field, keeping only known fields in
 * their expected primitive types. Never passes the input object itself
 * through — the output is a new object built entirely from validated
 * primitives, so nothing unvalidated (an unexpected extra field, an
 * unexpected type) reaches the generated source this gets embedded into.
 */
function sanitizeKey(raw, index, problems) {
  const label = (field) => `keys[${index}].${field}`;
  const kid = requireNonEmptyString(raw.kid, label("kid"), problems);
  const role = VALID_KEY_ROLES.has(raw.role)
    ? raw.role
    : problem(problems, `${label("role")} must be one of ${[...VALID_KEY_ROLES].join("/")}, got: ${JSON.stringify(raw.role)}`);
  const kty = requireNonEmptyString(raw.kty, label("kty"), problems);
  const alg = requireNonEmptyString(raw.alg, label("alg"), problems);
  return {
    kid: kid ?? "",
    role: role ?? "R3_audit",
    kty: kty ?? "",
    alg: alg ?? "",
    x: optionalString(raw.x, label("x"), problems),
    crv: optionalString(raw.crv, label("crv"), problems),
    valid_from: optionalString(raw.valid_from, label("valid_from"), problems),
    valid_until: optionalString(raw.valid_until, label("valid_until"), problems),
    replaced_by: optionalString(raw.replaced_by, label("replaced_by"), problems),
    revoked: optionalBoolean(raw.revoked, label("revoked"), problems) ?? false,
    tenant: optionalString(raw.tenant, label("tenant"), problems),
  };
}

function sanitizeRevocation(raw, index, problems) {
  const label = (field) => `revoked_keys[${index}].${field}`;
  const kid = requireNonEmptyString(raw.kid, label("kid"), problems);
  const revokedAt = requireIsoString(raw.revoked_at, label("revoked_at"), problems);
  return {
    kid: kid ?? "",
    role: optionalString(raw.role, label("role"), problems),
    revoked_at: revokedAt ?? "",
    reason: optionalString(raw.reason, label("reason"), problems),
  };
}

function sanitizeRevokedIdentity(raw, index, problems) {
  const label = (field) => `revoked_identities[${index}].${field}`;
  const identity = requireNonEmptyString(raw.identity, label("identity"), problems);
  const revokedAt = requireIsoString(raw.revoked_at, label("revoked_at"), problems);
  return {
    identity: identity ?? "",
    revoked_at: revokedAt ?? "",
    reason: optionalString(raw.reason, label("reason"), problems),
  };
}

/**
 * Rebuild the full snapshot from untrusted input field-by-field — never
 * pass the fetched/loaded objects through directly. This is what actually
 * gets embedded into committed SDK source (vendoredTrustRoot.generated.ts),
 * which every consumer of this package compiles into their own bundle, so
 * this refuses (throwing with every problem found) rather than silently
 * writing anything unvalidated or unexpectedly-shaped.
 */
function sanitizeSnapshot(trustRoot, verifierKeys, revocations) {
  const problems = [];
  const validUntil = requireIsoString(trustRoot?.valid_until, "valid_until", problems);
  const issuedAt = requireIsoString(trustRoot?.issued_at, "issued_at", problems);

  const rawKeys = requireArray(verifierKeys?.keys, "keys", problems);
  const keys = rawKeys.map((k, i) => sanitizeKey(k, i, problems));

  const rawRevokedKeys = requireArray(revocations?.revoked_keys, "revoked_keys", problems);
  const revokedKeys = rawRevokedKeys.map((r, i) => sanitizeRevocation(r, i, problems));

  const rawRevokedIdentities = requireArray(revocations?.revoked_identities, "revoked_identities", problems);
  const revokedIdentities = rawRevokedIdentities.map((r, i) => sanitizeRevokedIdentity(r, i, problems));

  if (problems.length > 0) {
    throw new Error(
      `refusing to vendor a malformed trust-root snapshot (${problems.length} problem(s)):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }

  return {
    valid_until: validUntil,
    issued_at: issuedAt,
    keys,
    revoked_keys: revokedKeys,
    revoked_identities: revokedIdentities,
  };
}

async function main() {
  const argPath = process.argv[2];
  const defaultLocalDir = resolve(here, "..", "..", "..", "atlasent-keys", ".well-known");
  const localDir = argPath
    ? resolve(process.cwd(), argPath)
    : existsSync(defaultLocalDir)
      ? defaultLocalDir
      : null;

  const { trustRoot, verifierKeys, revocations } = await loadThree(localDir);

  const snapshot = sanitizeSnapshot(trustRoot, verifierKeys, revocations);

  const j = (v) => JSON.stringify(v, null, 2);

  const ts = `// GENERATED-DERIVED — do not edit directly.
// Source: atlasent-keys' .well-known/{atlasent-trust-root,atlasent-verifier-keys,
//   atlasent-revocations}.json — the canonical public trust root published at
//   https://keys.atlasent.io/.well-known/.
// Re-vendor: node scripts/vendor-trust-root.mjs [path/to/atlasent-keys/.well-known]
// Do NOT hand-edit — update atlasent-keys upstream and re-vendor.
//
// This is the SDK's embedded baseline trust-root snapshot (see trustRoot.ts).
// It is a plain object literal on purpose: no file I/O, no path resolution,
// nothing Node-specific, so it is safe to bundle for any target (Node,
// browser, edge). TrustRootManager's background refresh keeps a
// long-running process current between vendoring passes; this baseline is
// what every process has from the very first call, with no network
// round-trip and no reliance on files shipping alongside dist/.

import type { TrustRootSnapshot } from "./trustRoot.js";

export const VENDORED_TRUST_ROOT_SNAPSHOT: TrustRootSnapshot = ${j(snapshot)};
`;

  writeFileSync(OUT_PATH, ts);
  console.log(
    `vendored ${OUT_PATH} from ${localDir ?? LIVE_BASE_URL} — ` +
      `${snapshot.keys.length} key(s), ${snapshot.revoked_keys.length} revocation(s), ` +
      `valid_until ${snapshot.valid_until}`,
  );
}

main().catch((err) => {
  console.error(`[vendor-trust-root] error: ${err.message}`);
  process.exitCode = 1;
});
