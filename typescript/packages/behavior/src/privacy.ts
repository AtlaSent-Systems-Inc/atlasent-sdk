// Read-side privacy guard — mirrors the ingest-time blocklist in
// behavior-insights/src/lib/insights/privacy.ts. Defense-in-depth:
// even if the aggregate surface accidentally includes a raw text field,
// the SDK rejects it before the caller ever sees it.
const RAW_TEXT_FIELDS = new Set([
  "text",
  "note",
  "cue",
  "interpretation",
  "body",
  "content",
  "message",
  "description",
  "narrative",
  "transcript",
  "raw",
  "freetext",
]);

export class RawTextLeakError extends Error {
  constructor(public readonly field: string, public readonly path: string) {
    super(
      `Privacy violation: raw text field "${field}" found at ${path} — ` +
      `aggregate-only surface must never expose raw text`,
    );
    this.name = "RawTextLeakError";
  }
}

export function assertNoRawText(data: unknown, path = "response"): void {
  if (data === null || typeof data !== "object") return;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (RAW_TEXT_FIELDS.has(key)) {
      throw new RawTextLeakError(key, `${path}.${key}`);
    }
    if (value !== null && typeof value === "object") {
      assertNoRawText(value, `${path}.${key}`);
    }
  }
}
