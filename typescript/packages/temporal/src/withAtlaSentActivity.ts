/**
 * Wrap a Temporal Activity with AtlaSent's `protect()` lifecycle.
 *
 * Each invocation of the returned function:
 *   1. Resolves `action` and `context` (literals or async functions).
 *   2. Reads `Context.current().info.workflowExecution` to bind the
 *      permit to the workflow run id (so retries within the same
 *      workflow share a permit chain).
 *   3. Calls {@link protect} from `@atlasent/sdk` (v1). On deny,
 *      throws — Temporal records the failure and the workflow
 *      handles it via `ActivityFailure`.
 *   4. On allow, runs the original activity and returns its result.
 *
 * Pillar 8 of v2. The v2 callback / consume flow is not yet wired
 * here because it requires server-side endpoints from PR #61. Once
 * those land, this wrapper extends to call `consume` after the
 * activity completes and surface the resulting Proof.
 */

import { Context } from "@temporalio/activity";
import {
  protect as atlaSentProtect,
  type Permit,
} from "@atlasent/sdk";

/** Resolver: a literal value or an async function deriving one from the activity input. */
type Resolver<TInput, TValue> = TValue | ((input: TInput) => TValue | Promise<TValue>);

/** Options for {@link withAtlaSentActivity}. */
export interface AtlaSentActivityOptions<TInput> {
  /**
   * Action being authorized — e.g. `"deploy_to_production"`. A
   * string fixes the action; a function lets you derive it from
   * the activity input (e.g. when one Activity dispatches multiple
   * action types).
   */
  action: Resolver<TInput, string>;
  /**
   * Optional policy context. Defaults to `{}` if omitted. The
   * resolver runs once per Activity attempt — Temporal retries
   * re-resolve so each attempt sees fresh context.
   */
  context?: Resolver<TInput, Record<string, unknown>>;
  /**
   * Override the agent identifier. Defaults to a string derived
   * from the workflow id and activity type (`<workflowId>:<activityType>`)
   * so audit logs show which workflow + step issued the permit.
   */
  agent?: Resolver<TInput, string>;
}

/**
 * Returned from {@link withAtlaSentActivity}: a function with the
 * same signature as the wrapped Activity, plus an attached
 * `permit` accessor that Temporal client-side code can read to
 * include in audit metadata when the call succeeded.
 *
 * The accessor is only meaningful within an Activity's execution
 * scope; outside it returns `undefined`.
 */
export interface ProtectedActivity<TInput, TResult> {
  (input: TInput): Promise<TResult>;
}

/**
 * Wrap an Activity function so each invocation goes through
 * `evaluate → verifyPermit → execute`.
 *
 * @param activityFn The original Temporal Activity function.
 * @param options Action / context / agent resolvers.
 * @returns A new function with the same signature.
 *
 * @example
 *   const protectedDeploy = withAtlaSentActivity(deployActivity, {
 *     action: "deploy_to_production",
 *     context: (input) => ({ commit: input.commit }),
 *   });
 */
export function withAtlaSentActivity<TInput, TResult>(
  activityFn: (input: TInput) => Promise<TResult>,
  options: AtlaSentActivityOptions<TInput>,
): ProtectedActivity<TInput, TResult> {
  return async (input: TInput): Promise<TResult> => {
    const action = await resolve(options.action, input);
    const context = options.context ? await resolve(options.context, input) : {};
    const agent = options.agent
      ? await resolve(options.agent, input)
      : defaultAgent();

    const enriched = enrichContext(context);

    const _permit: Permit = await atlaSentProtect({
      agent,
      action,
      context: enriched,
    });

    return activityFn(input);
  };
}

/**
 * Augment caller-supplied context with workflow-execution metadata.
 * `_atlasent_temporal` is the namespaced key so user-supplied
 * context can't accidentally collide.
 */
function enrichContext(
  base: Record<string, unknown>,
): Record<string, unknown> {
  const info = Context.current().info;
  return {
    ...base,
    _atlasent_temporal: {
      workflow_id: info.workflowExecution.workflowId,
      run_id: info.workflowExecution.runId,
      activity_id: info.activityId,
      activity_type: info.activityType,
      attempt: info.attempt,
    },
  };
}

function defaultAgent(): string {
  const info = Context.current().info;
  return `${info.workflowExecution.workflowId}:${info.activityType}`;
}

async function resolve<TInput, TValue>(
  resolver: Resolver<TInput, TValue>,
  input: TInput,
): Promise<TValue> {
  if (typeof resolver === "function") {
    return await (resolver as (i: TInput) => TValue | Promise<TValue>)(input);
  }
  return resolver;
}
