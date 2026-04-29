/**
 * Deterministic canonical JSON for the v2 Pillar 9 proof flow.
 *
 * This function MUST produce identical output to:
 *   - The v1 SDK's `canonicalJSON` in `typescript/src/auditBundle.ts`
 *   - The v1 Python SDK's `canonical_json` in
 *     `python/atlasent/audit_bundle.py`
 *   - The server-side reference in `atlasent-api/.../rules.ts`
 *
 * Rules:
 *   - Object keys sorted lexicographically at every depth
 *   - No whitespace between tokens
 *   - `null`, `undefined`, `NaN`, `±Infinity` all render as `"null"`
 *   - Strings use standard `JSON.stringify` escapes
 *
 * Why re-implement rather than import from the v1 SDK? This package
 * must not take a runtime dependency on v1 until v2 GA decides on a
 * consolidation story. Byte parity is kept honest via
 * `test/canonicalize.test.ts`.
 *
 * @see `contract/schemas/v2/README.md` §1 — canonicalization
 */
export function canonicalizePayload(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
        .join(",") +
      "}"
    );
  }
  return "null";
}
