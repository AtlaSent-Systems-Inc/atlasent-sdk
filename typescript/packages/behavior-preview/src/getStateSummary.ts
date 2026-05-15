import type { GetStateSummaryOptions, StateSummary } from "./types.js";
import { notImplemented } from "./errors.js";

export function getStateSummary(
  _userId: string,
  _opts?: GetStateSummaryOptions,
): Promise<StateSummary> {
  return notImplemented();
}
