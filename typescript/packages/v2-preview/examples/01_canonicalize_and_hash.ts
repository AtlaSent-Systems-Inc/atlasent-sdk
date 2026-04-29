/**
 * Pillar 9 primitives — canonical JSON + SHA-256 hashing.
 *
 * Demonstrates that:
 *   1. `canonicalizePayload` produces deterministic byte output —
 *      sorted keys at every depth, no whitespace, escapes.
 *   2. `hashPayload` is the SHA-256 of that canonical output —
 *      the same hash the server will compute on its side, so the
 *      raw payload never has to leave the client.
 *
 * Run:  npx tsx examples/01_canonicalize_and_hash.ts
 */

import { canonicalizePayload, hashPayload } from "../src/index.js";

// Two structurally identical payloads with different key order.
const a = { commit: "abc123", env: "prod", approver: "sre@example.com" };
const b = { approver: "sre@example.com", env: "prod", commit: "abc123" };

// Canonical output is byte-identical regardless of input key order.
const canonicalA = canonicalizePayload(a);
const canonicalB = canonicalizePayload(b);
console.log("canonical(a):", canonicalA);
console.log("canonical(b):", canonicalB);
console.log("byte-equal?  ", canonicalA === canonicalB); // true

// And so are their hashes — the only thing the v2 protect() flow
// actually sends to the server.
console.log("hash(a):", hashPayload(a));
console.log("hash(b):", hashPayload(b));

// Nested objects, arrays, unicode, nulls — all canonicalize the same
// way they would in Python or Go.
const complex = {
  zebra: ["last", "in", "iter", "but", "not", "in", "output"],
  alpha: { nested: { z: 3, a: 1 }, "漢": null },
  null_field: null,
};
console.log("\ncomplex canonical:");
console.log(canonicalizePayload(complex));
