const RAW_TEXT_FIELDS = new Set([
  "text",
  "note",
  "cue",
  "interpretation",
  "body",
  "content",
  "transcript",
  "message",
  "description",
  "comment",
  "narrative",
  "label",
  "reasoning",
  "rationale",
]);

export class RawTextLeakError extends Error {
  constructor(public readonly field: string) {
    super(
      `BVS event contains raw-text field "${field}" — privacy violation. ` +
        `Strip or omit this field before emitting.`,
    );
    this.name = "RawTextLeakError";
  }
}

export function assertNoRawText(value: unknown, path = ""): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (RAW_TEXT_FIELDS.has(k) && typeof v === "string" && v.trim() !== "") {
      throw new RawTextLeakError(path ? `${path}.${k}` : k);
    }
    assertNoRawText(v, path ? `${path}.${k}` : k);
  }
}
