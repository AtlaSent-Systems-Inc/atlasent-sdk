import { DisallowedConfigError, NotImplementedError } from "./errors.js";
import type {
  EnforceConfig,
  EnforceRunRequest,
  EnforceRunResult,
} from "./types.js";

export class Enforce {
  readonly #config: EnforceConfig;

  constructor(config: EnforceConfig) {
    if ((config as { failClosed: unknown }).failClosed !== true) {
      throw new DisallowedConfigError(
        "Enforce.failClosed must be true. Fail-closed is non-toggleable; see contract/ENFORCE_PACK.md invariant 2.",
      );
    }
    this.#config = config;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run<T>(_request: EnforceRunRequest<T>): Promise<EnforceRunResult<T>> {
    throw new NotImplementedError(
      "Enforce.run is not yet implemented. Implementation lands behind SIM-01..SIM-10; see contract/SIM_SCENARIOS.md.",
    );
  }
}
