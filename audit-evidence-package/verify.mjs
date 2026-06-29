#!/usr/bin/env node
// Offline verification of an AtlaSent evidence bundle (Node, zero dependencies).
//
// Uses ONLY the Node standard library (`node:crypto`, `node:fs`). There is
// nothing to `npm install` and nothing to trust beyond Node itself and this
// file, which you can read top to bottom in a couple of minutes. It contacts
// no network and is deterministic for the same input.
//
// It is an INDEPENDENT re-implementation of the canonical verifier
// (`@atlasent/sdk` `verifyEvidenceBundle` / `atlasent` `verify_evidence_bundle`),
// kept byte-for-byte in step via the shared test vectors. Running this AND the
// Python verifier and getting the same answer is two independent
// implementations agreeing — exactly the cross-check a skeptical reviewer wants.
//
// Algorithm (see docs/02-hash-chain.md and docs/03-cryptographic-assumptions.md):
//   1. Signature : Ed25519 over sha256(canonical_json(bundle without `signature`)).
//   2. Chain     : each record.entry_hash == sha256(prev_hash_bytes || canonical
//                  payload); prev_hash links the chain; anchors match chain_context.
//   3. Summary   : summary_hash == RFC 6962 Merkle root over the entry_hash leaves.
//
// Usage:  node verify.mjs [bundle.json] [trust-root.json]
// Exit:   0 = PASS (all checks), 1 = FAIL, 2 = usage/read error.

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

class VerifyError extends Error {}

/** Recursively key-sorted, compact JSON — the twin of the SDK's canonicalJson. */
function canonicalJson(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new VerifyError("floating-point values are not canonicalizable in v1");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",") + "}";
  }
  throw new VerifyError(`uncanonicalizable type: ${typeof value}`);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest();
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** entry_hash = sha256( prev_hash_bytes || canonical_json(record sans entry_hash/signature) ). */
function recordEntryHash(record) {
  const content = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== "entry_hash" && k !== "signature") content[k] = v;
  }
  const prevBytes = Buffer.from(record.prev_hash, "hex");
  return sha256hex(Buffer.concat([prevBytes, Buffer.from(canonicalJson(content), "utf8")]));
}

/** RFC 6962 Merkle root (hex) over hex-string leaves. */
function merkleRootHex(leafHexes) {
  if (leafHexes.length === 0) return sha256hex(Buffer.alloc(0));
  let level = leafHexes.map((h) => sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(h, "hex")])));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha256(Buffer.concat([Buffer.from([0x01]), level[i], level[i + 1]])));
      } else {
        next.push(level[i]); // odd node promoted
      }
    }
    level = next;
  }
  return level[0].toString("hex");
}

/** Import a raw 32-byte Ed25519 public key (from `public_key_b64`) as a KeyObject. */
function ed25519PublicKey(publicKeyB64) {
  const raw = Buffer.from(publicKeyB64, "base64");
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

function resolveKey(keySet, keyId) {
  for (const k of keySet.issuing_keys ?? []) {
    if (k.key_id === keyId) {
      if (k.alg !== "Ed25519") throw new VerifyError(`unsupported key alg: ${k.alg}`);
      return ed25519PublicKey(k.public_key_b64);
    }
  }
  throw new VerifyError(`unknown_key_id: key_id not in key set: ${keyId}`);
}

function require_(cond, message) {
  if (!cond) throw new VerifyError(message);
}

function verifyEvidenceBundle(bundle, keySet) {
  if (typeof bundle !== "object" || bundle === null) throw new VerifyError("bundle is not an object");
  for (const f of ["records", "chain_context", "summary_hash", "signature"]) {
    require_(f in bundle, `missing field: ${f}`);
  }

  const sig = bundle.signature;
  require_(sig && typeof sig === "object", "signature is not an object");
  require_(sig.alg === "Ed25519", "unsupported signature alg");
  for (const f of ["key_id", "signature_b64"]) require_(f in sig, `missing signature.${f}`);

  // 1. Signature over canonical bytes (signature field omitted), SHA-256 then Ed25519.
  const pubkey = resolveKey(keySet, sig.key_id);
  const signingInput = {};
  for (const [k, v] of Object.entries(bundle)) if (k !== "signature") signingInput[k] = v;
  const digest = sha256(Buffer.from(canonicalJson(signingInput), "utf8"));
  const ok = edVerify(null, digest, pubkey, Buffer.from(sig.signature_b64, "base64"));
  require_(ok, "signature_invalid: Ed25519 signature did not verify");

  // 2. Chain binding.
  const records = bundle.records;
  const chain = bundle.chain_context;
  require_(Array.isArray(records) && records.length > 0, "no records");
  require_(chain.entry_count === records.length, "chain_context.entry_count != number of records");
  let prev = chain.first_prev_hash;
  records.forEach((rec, i) => {
    require_(recordEntryHash(rec) === rec.entry_hash, `record[${i}].entry_hash does not match recomputed content hash`);
    require_(rec.prev_hash === prev, `record[${i}].prev_hash does not link to the prior entry`);
    prev = rec.entry_hash;
  });
  require_(records[0].entry_hash === chain.first_entry_hash, "chain_context.first_entry_hash mismatch");
  require_(records[records.length - 1].entry_hash === chain.last_entry_hash, "chain_context.last_entry_hash mismatch");

  // 3. summary_hash = RFC 6962 Merkle root over record entry_hash leaves.
  const expectedRoot = merkleRootHex(records.map((r) => r.entry_hash));
  require_(expectedRoot === bundle.summary_hash, "summary_hash_mismatch: recomputed Merkle root does not match summary_hash");

  return {
    ok: true,
    bundle_id: bundle.bundle_id,
    key_id: sig.key_id,
    record_count: records.length,
    checks: ["signature", "chain_binding", "summary_hash"],
  };
}

function main() {
  const bundlePath = process.argv[2] ?? resolve(HERE, "bundle.json");
  const keysetPath = process.argv[3] ?? resolve(HERE, "trust-root.json");

  let bundle, keySet;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
    keySet = JSON.parse(readFileSync(keysetPath, "utf8"));
  } catch (err) {
    console.error(`error: cannot read input: ${err.message}`);
    return 2;
  }

  try {
    const r = verifyEvidenceBundle(bundle, keySet);
    console.log(
      `PASS  bundle_id=${r.bundle_id}  key_id=${r.key_id}  records=${r.record_count}  checks=${r.checks.join(",")}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof VerifyError) {
      console.log(`FAIL  ${err.message}`);
      return 1;
    }
    throw err;
  }
}

process.exit(main());
