import type { EvaluateRequestLike } from "./types.js";
import { notImplemented } from "./errors.js";

export function attachToEvaluate<T extends EvaluateRequestLike>(
  _request: T,
  _userId: string,
): Promise<T> {
  return notImplemented();
}
