/**
 * `requirePermit` — higher-order execution gate for dangerous operations.
 *
 * Wraps any dangerous operation so it can only run after AtlaSent
 * authorizes it end-to-end (evaluate + verifyPermit). If authorization
 * is denied or the transport fails, the executor is never called.
 *
 * ```ts
 * import atlasent from "@atlasent/sdk";
 *
 * await atlasent.requirePermit(
 *   {
 *     action_type: "database.table.drop",
 *     actor_id: "agent:code-agent",
 *     resource_id: "prod-db.users",
 *     environment: "production",
 *     context: { reversibility: "irreversible", blast_radius: "customer_data" },
 *   },
 *   async () => {
 *     await db.raw("DROP TABLE users");
 *   },
 * );
 * ```
 *
 * Unlike calling the executor directly, dangerous code cannot bypass
 * this gate: if `requirePermit` throws, the executor never runs.
 */

import { protect } from "./protect.js";

/**
 * Catalog of built-in protected action types, mirroring `CanonicalProtectedActionType`
 * in the OpenAPI spec. Use these constants as `action_type` values in
 * {@link requirePermit} calls instead of bare strings.
 *
 * ```ts
 * await requirePermit(
 *   { action_type: CanonicalProtectedActionType.DATABASE_TABLE_DELETE, ... },
 *   () => db.raw("DELETE FROM users"),
 * );
 * ```
 */
export const CanonicalProtectedActionType = {
  PRODUCTION_DEPLOY: "production.deploy",
  HR_EMPLOYEE_OFFBOARD: "hr.employee.offboard",
  HR_ACCESS_REVOKE: "hr.access.revoke",
  HR_ROLE_ESCALATE: "hr.role.escalate",
  ML_MODEL_PROMOTE: "ml.model.promote",
  ML_MODEL_RETIRE: "ml.model.retire",
  ML_MODEL_FINE_TUNE: "ml.model.fine_tune",
  CUSTOMER_DATA_DELETE: "customer.data.delete",
  CONTRACT_EXECUTE: "contract.execute",
  CONTRACT_AMEND: "contract.amend",
  PRICING_RULE_PUBLISH: "pricing.rule.publish",
  PRICING_DISCOUNT_APPROVE: "pricing.discount.approve",
  SECURITY_INCIDENT_ESCALATE: "security.incident.escalate",
  SECURITY_ACCESS_QUARANTINE: "security.access.quarantine",
  ACCESS_CERT_REVOKE: "access.cert.revoke",
  PERIOD_CLOSE_CERTIFY: "period.close.certify",
  DATABASE_MIGRATION_APPLY: "database.migration.apply",
  DATABASE_SCHEMA_DROP: "database.schema.drop",
  DATABASE_TABLE_DELETE: "database.table.delete",
} as const;

export type CanonicalProtectedActionType =
  (typeof CanonicalProtectedActionType)[keyof typeof CanonicalProtectedActionType];

/**
 * Describes a potentially dangerous action to be authorized before
 * the executor runs. Passed as the first argument to {@link requirePermit}.
 */
export type ProtectedAction = {
  /** Namespaced action type — e.g. "database.table.drop". */
  action_type: string;
  /** Agent or user requesting the action — e.g. "agent:deploy-bot". */
  actor_id: string;
  /** Resource being acted upon — e.g. "prod-db.users". */
  resource_id: string;
  /** Target deployment environment. Controls policy strictness. */
  environment: "development" | "staging" | "production";
  /** Arbitrary risk context forwarded to the policy engine. */
  context: Record<string, unknown>;
};

/**
 * Authorize a dangerous operation before running it.
 *
 * Calls `protect` (evaluate + verifyPermit) with the {@link ProtectedAction}
 * descriptor. If authorization succeeds, calls `execute` and returns its
 * result. On any failure — policy deny, invalid permit, transport error —
 * `execute` is never called and the error propagates to the caller.
 *
 * This is the pattern primitive: dangerous code should be callable
 * **only** through this wrapper. In code review, any operation in the list
 * below is illegal unless it appears inside `requirePermit(...)`:
 *
 *   - `db.raw(...)` / `DROP TABLE` / `DELETE FROM` / `TRUNCATE TABLE`
 *   - `exec(...)` / `rm -rf` / `kubectl delete` / `terraform destroy`
 *   - `stripe.transfers.create(...)` / `github.deployments.create(...)`
 *   - `railway.volumes.delete(...)` / `supabase.from(...).delete()`
 */
export async function requirePermit<T>(
  action: ProtectedAction,
  execute: () => Promise<T>,
): Promise<T> {
  await protect({
    agent: action.actor_id,
    action: action.action_type,
    context: {
      resource_id: action.resource_id,
      environment: action.environment,
      ...action.context,
    },
  });
  return execute();
}

/**
 * Patterns for shell / database commands that are dangerous and must
 * be wrapped in {@link requirePermit} before execution.
 */
const DESTRUCTIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /rm\s+-rf/,
  /DROP\s+TABLE/i,
  /DROP\s+DATABASE/i,
  /DELETE\s+FROM/i,
  /TRUNCATE\s+TABLE/i,
  /railway\s+volume\s+delete/i,
  /kubectl\s+delete/i,
  /terraform\s+destroy/i,
];

/**
 * Classify a shell or database command as destructive.
 *
 * Returns the namespaced action type (e.g. `"destructive.command"`) when the
 * command matches a known dangerous pattern, or `null` when it appears safe.
 * Use the return value as `action_type` in a {@link requirePermit} call before
 * executing the command:
 *
 * ```ts
 * async function runCommand(command: string, actorId: string) {
 *   const actionType = classifyCommand(command);
 *   if (actionType) {
 *     return requirePermit(
 *       { action_type: actionType, actor_id: actorId, resource_id: command,
 *         environment: "production", context: { command } },
 *       () => exec(command),
 *     );
 *   }
 *   return exec(command);
 * }
 * ```
 */
export function classifyCommand(command: string): string | null {
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(command))
    ? "destructive.command"
    : null;
}
