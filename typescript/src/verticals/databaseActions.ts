import { protectOrEscalate } from "../approvalRuntime.js";
import { protect } from "../protect.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import { AtlaSentDeniedError } from "../errors.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { Permit } from "../protect.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type DatabaseMigrationActionType = "database.migration.apply";
export type DatabaseDestructiveActionType =
  | "database.schema.drop"
  | "database.table.delete";
export type DatabaseActionType =
  | DatabaseMigrationActionType
  | DatabaseDestructiveActionType;

export interface PermitEvidence {
  action: DatabaseActionType;
  databaseId: string;
  authorizedBy: string;
  permitToken: string;
  timestamp: string;
  context: Record<string, unknown>;
}

export interface DenialEvidence {
  action: DatabaseActionType;
  databaseId: string;
  authorizedBy: string;
  denialReason: string;
  evaluationId?: string;
  timestamp: string;
  context: Record<string, unknown>;
}

export interface DatabaseActionOptions {
  action: DatabaseActionType;
  databaseId: string;
  authorizedBy: string;
  environment: "production" | "staging" | "development";
  // migration-specific
  migrationId?: string;
  migrationChecksum?: string;
  rollbackPlan?: string;
  // destructive-specific (schema.drop / table.delete)
  schemaName?: string;
  tableName?: string;
  backupVerified?: boolean;
  recoveryPointId?: string;
  // evidence callbacks — called after the gate resolves
  onPermitEvidence?: (evidence: PermitEvidence) => void | Promise<void>;
  onDenialEvidence?: (evidence: DenialEvidence) => void | Promise<void>;
  // escalation overrides
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export async function protectDatabaseAction(
  opts: DatabaseActionOptions,
): Promise<ApprovalPermit | Permit> {
  // ── Validate required fields ─────────────────────────────────────────────

  if (opts.action === "database.migration.apply") {
    if (!opts.migrationId) {
      throw new TypeError(
        `Database action 'database.migration.apply' requires 'migrationId'`,
      );
    }
    if (!opts.migrationChecksum) {
      throw new TypeError(
        `Database action 'database.migration.apply' requires 'migrationChecksum'`,
      );
    }
    if (opts.environment === "production" && !opts.rollbackPlan) {
      throw new TypeError(
        `Database action 'database.migration.apply' in production requires 'rollbackPlan'`,
      );
    }
  }

  if (opts.action === "database.schema.drop") {
    if (!opts.schemaName) {
      throw new TypeError(
        `Database action 'database.schema.drop' requires 'schemaName'`,
      );
    }
    if (!opts.backupVerified) {
      throw new TypeError(
        `Database action 'database.schema.drop' requires 'backupVerified: true'`,
      );
    }
    if (!opts.recoveryPointId) {
      throw new TypeError(
        `Database action 'database.schema.drop' requires 'recoveryPointId'`,
      );
    }
  }

  if (opts.action === "database.table.delete") {
    if (!opts.tableName) {
      throw new TypeError(
        `Database action 'database.table.delete' requires 'tableName'`,
      );
    }
    if (!opts.backupVerified) {
      throw new TypeError(
        `Database action 'database.table.delete' requires 'backupVerified: true'`,
      );
    }
    if (!opts.recoveryPointId) {
      throw new TypeError(
        `Database action 'database.table.delete' requires 'recoveryPointId'`,
      );
    }
  }

  // ── Determine risk profile ────────────────────────────────────────────────

  const isDestructive =
    opts.action === "database.schema.drop" ||
    opts.action === "database.table.delete";
  const riskLevel = isDestructive ? "critical" : "high";

  // migration in production is not machine-executable; destructive never is
  const machineExecutable =
    opts.action === "database.migration.apply" &&
    opts.environment !== "production";

  // ── Build context ─────────────────────────────────────────────────────────

  const ctx = buildActionContext({
    actor: {
      id: opts.authorizedBy,
      type: "human",
    },
    resource: {
      id: opts.databaseId,
      type: "database",
      sensitivity: "restricted",
    },
    environment: opts.environment,
    action_meta: {
      risk_level: riskLevel,
      reversibility: isDestructive ? "irreversible" : "reversible",
      description: `Database action '${opts.action}' on database '${opts.databaseId}'`,
    },
    extra: {
      database_action: opts.action,
      database_id: opts.databaseId,
      machine_executable: machineExecutable,
      ...(isDestructive ? { deny_by_default: true } : {}),
      ...(opts.migrationId !== undefined
        ? { migration_id: opts.migrationId }
        : {}),
      ...(opts.migrationChecksum !== undefined
        ? { migration_checksum: opts.migrationChecksum }
        : {}),
      ...(opts.rollbackPlan !== undefined
        ? { rollback_plan: opts.rollbackPlan }
        : {}),
      ...(opts.schemaName !== undefined
        ? { schema_name: opts.schemaName }
        : {}),
      ...(opts.tableName !== undefined ? { table_name: opts.tableName } : {}),
      ...(opts.backupVerified !== undefined
        ? { backup_verified: opts.backupVerified }
        : {}),
      ...(opts.recoveryPointId !== undefined
        ? { recovery_point_id: opts.recoveryPointId }
        : {}),
    },
  });

  const request = {
    action: opts.action,
    agent: opts.authorizedBy,
    context: flattenActionContext(ctx),
  };

  // ── Route through gate ────────────────────────────────────────────────────

  if (machineExecutable) {
    // staging/development migration: direct protect()
    try {
      const result = await protect(request);
      if (opts.onPermitEvidence) {
        const permitToken = result.permitId;
        await opts.onPermitEvidence({
          action: opts.action,
          databaseId: opts.databaseId,
          authorizedBy: opts.authorizedBy,
          permitToken,
          timestamp: new Date().toISOString(),
          context: request.context as Record<string, unknown>,
        });
      }
      return result;
    } catch (err) {
      if (err instanceof AtlaSentDeniedError && opts.onDenialEvidence) {
        await opts.onDenialEvidence({
          action: opts.action,
          databaseId: opts.databaseId,
          authorizedBy: opts.authorizedBy,
          denialReason: err.reason ?? "denied",
          evaluationId: err.evaluationId,
          timestamp: new Date().toISOString(),
          context: request.context as Record<string, unknown>,
        });
      }
      throw err;
    }
  }

  // non-machine-executable: escalation required
  const quorum = isDestructive ? "two_thirds" : "single_approver";
  const defaultWaitMs = isDestructive
    ? 24 * 60 * 60 * 1000 // 24h for destructive
    : 4 * 60 * 60 * 1000; // 4h for production migration

  const escalationOpts = {
    escalationReason: `Database action '${opts.action}' on '${opts.databaseId}' requires human review (machine_executable: false)`,
    assignedToRole: "database-admin",
    quorumRequired: quorum as "single_approver" | "two_thirds",
    waitMs: opts.waitMs ?? defaultWaitMs,
    ...(opts.onEscalationCreated !== undefined
      ? { onEscalationCreated: opts.onEscalationCreated }
      : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
  };

  try {
    const result = await protectOrEscalate(request, escalationOpts);
    if (opts.onPermitEvidence) {
      const permitToken =
        "permit_token" in result
          ? (result as { permit_token: string }).permit_token
          : result.escalationId || result.permitId;
      await opts.onPermitEvidence({
        action: opts.action,
        databaseId: opts.databaseId,
        authorizedBy: opts.authorizedBy,
        permitToken,
        timestamp: new Date().toISOString(),
        context: request.context as Record<string, unknown>,
      });
    }
    return result;
  } catch (err) {
    if (err instanceof AtlaSentDeniedError && opts.onDenialEvidence) {
      await opts.onDenialEvidence({
        action: opts.action,
        databaseId: opts.databaseId,
        authorizedBy: opts.authorizedBy,
        denialReason: err.reason ?? "denied",
        evaluationId: err.evaluationId,
        timestamp: new Date().toISOString(),
        context: request.context as Record<string, unknown>,
      });
    }
    throw err;
  }
}

export async function protectDatabaseMigration(
  opts: Omit<DatabaseActionOptions, "action"> & {
    migrationId: string;
    migrationChecksum: string;
  },
): Promise<ApprovalPermit | Permit> {
  return protectDatabaseAction({ ...opts, action: "database.migration.apply" });
}

export async function protectDatabaseSchemaDrop(
  opts: Omit<DatabaseActionOptions, "action"> & {
    schemaName: string;
    backupVerified: true;
    recoveryPointId: string;
  },
): Promise<ApprovalPermit | Permit> {
  return protectDatabaseAction({ ...opts, action: "database.schema.drop" });
}

export async function protectDatabaseTableDelete(
  opts: Omit<DatabaseActionOptions, "action"> & {
    tableName: string;
    backupVerified: true;
    recoveryPointId: string;
  },
): Promise<ApprovalPermit | Permit> {
  return protectDatabaseAction({ ...opts, action: "database.table.delete" });
}
