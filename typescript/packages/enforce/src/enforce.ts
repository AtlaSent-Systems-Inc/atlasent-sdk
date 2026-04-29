import { DisallowedConfigError, LatencyBreachSignal, classifyClientError } from "./errors.js";
import type {
  EnforceConfig,
  EnforceRunRequest,
  EnforceRunResult,
  VerifiedPermit,
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

  async run<T>(request: EnforceRunRequest<T>): Promise<EnforceRunResult<T>> {
    // Step 1: evaluate
    let evalResponse;
    try {
      evalResponse = await this.#config.client.evaluate(request.request); // enforce-no-bypass: allow
    } catch (err) {
      return {
        decision: "deny",
        reasonCode: classifyClientError(err, "evaluate_unavailable"),
      };
    }

    if (evalResponse.decision !== "allow" || !evalResponse.permit) {
      return {
        decision: evalResponse.decision as "deny" | "hold" | "escalate",
        reasonCode: evalResponse.reasonCode ?? evalResponse.decision,
      };
    }

    const permitToken = evalResponse.permit.token;

    // Step 2: verifyPermit (with optional latency budget)
    let verifiedPermit: VerifiedPermit;
    try {
      verifiedPermit = await this.#verifyWithBudget(permitToken);
    } catch (err) {
      if (err instanceof LatencyBreachSignal) {
        return { decision: "deny", reasonCode: "verify_latency_breach" };
      }
      return {
        decision: "deny",
        reasonCode: classifyClientError(err, "verify_unavailable"),
      };
    }

    // Step 3: binding check (belt-and-suspenders in addition to server-side check)
    const b = this.#config.bindings;
    if (
      verifiedPermit.orgId !== b.orgId ||
      verifiedPermit.actorId !== b.actorId ||
      verifiedPermit.actionType !== b.actionType
    ) {
      return { decision: "deny", reasonCode: "binding_mismatch" };
    }

    // Step 4: execute
    const value = await request.execute(verifiedPermit);
    return { decision: "allow", value, permit: verifiedPermit };
  }

  async #verifyWithBudget(token: string): Promise<VerifiedPermit> {
    const { latencyBudgetMs, latencyBreachMode, onLatencyBreach } = this.#config;

    if (latencyBudgetMs === undefined) {
      return this.#config.client.verifyPermit(token);
    }

    const verifyPromise = this.#config.client.verifyPermit(token);

    const timeoutResult = await Promise.race([
      verifyPromise.then((v) => ({ kind: "ok" as const, value: v })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), latencyBudgetMs),
      ),
    ]);

    if (timeoutResult.kind === "ok") {
      return timeoutResult.value;
    }

    // Latency budget breached
    if (latencyBreachMode === "warn") {
      onLatencyBreach?.();
      return verifyPromise; // still wait for the actual result
    }

    throw new LatencyBreachSignal();
  }
}
