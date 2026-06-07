export { createBehaviorEmitter, BvsEmitError } from "./client.js";
export { assertNoRawText, RawTextLeakError } from "./privacy.js";
export type {
  BvsSource,
  BvsFactorKey,
  BvsFactorIntensity,
  BvsContextFactor,
  BvsEpisodeEvent,
  BvsPracticeEvent,
  BvsIntentionEvent,
  BvsReflectionEvent,
  BvsEvent,
  BehaviorEmitOptions,
  BehaviorEmitter,
  EmitResult,
} from "./types.js";
