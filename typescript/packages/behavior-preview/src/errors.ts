export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

const SCAFFOLD_MSG =
  "@atlasent/behavior-preview is a scaffold. " +
  "Implementation lands when behavior-insights ships BI2-BI5. " +
  "See behavior-insights/V2_ROLLOUT.md and issue #9.";

export function notImplemented(): never {
  throw new NotImplementedError(SCAFFOLD_MSG);
}
