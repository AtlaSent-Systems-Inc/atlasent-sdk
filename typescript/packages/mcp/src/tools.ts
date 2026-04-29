/**
 * Pure tool-handler functions, decoupled from MCP wire protocol.
 * Each function takes validated arguments and a client, returns a
 * JSON-serialisable result object or throws an error.
 *
 * Keeping handlers separate from the MCP Server wiring makes unit
 * tests straightforward — no transport setup needed.
 */

import {
  AtlaSentClient,
  AtlaSentDeniedError,
  AtlaSentError,
} from "@atlasent/sdk";
import type {
  EvaluateResponse,
  VerifyPermitResponse,
  ApiKeySelfResponse,
  Permit,
} from "@atlasent/sdk";

// ── tool input shapes ──────────────────────────────────────────────────────

export interface EvaluateArgs {
  agent: string;
  action: string;
  context?: Record<string, unknown>;
}

export interface ProtectArgs {
  agent: string;
  action: string;
  context?: Record<string, unknown>;
}

export interface VerifyPermitArgs {
  permitId: string;
  agent?: string;
  action?: string;
  context?: Record<string, unknown>;
}

// ── handlers ──────────────────────────────────────────────────────────────

export async function toolEvaluate(
  client: AtlaSentClient,
  args: EvaluateArgs,
): Promise<EvaluateResponse> {
  return client.evaluate({
    agent: args.agent,
    action: args.action,
    ...(args.context !== undefined ? { context: args.context } : {}),
  });
}

export async function toolProtect(
  client: AtlaSentClient,
  args: ProtectArgs,
): Promise<Permit> {
  const evalResp = await client.evaluate({
    agent: args.agent,
    action: args.action,
    ...(args.context !== undefined ? { context: args.context } : {}),
  });

  if (evalResp.decision !== "ALLOW") {
    throw new AtlaSentDeniedError({
      decision: "deny",
      evaluationId: evalResp.permitId,
      reason: evalResp.reason,
      auditHash: evalResp.auditHash,
    });
  }

  const verifyResp = await client.verifyPermit({
    permitId: evalResp.permitId,
    agent: args.agent,
    action: args.action,
    ...(args.context !== undefined ? { context: args.context } : {}),
  });

  if (!verifyResp.verified) {
    throw new AtlaSentDeniedError({
      decision: "deny",
      evaluationId: evalResp.permitId,
      reason: `permit verification failed: ${verifyResp.outcome}`,
      auditHash: evalResp.auditHash,
    });
  }

  return {
    permitId: evalResp.permitId,
    permitHash: verifyResp.permitHash,
    auditHash: evalResp.auditHash,
    reason: evalResp.reason,
    timestamp: verifyResp.timestamp,
  };
}

export async function toolVerifyPermit(
  client: AtlaSentClient,
  args: VerifyPermitArgs,
): Promise<VerifyPermitResponse> {
  return client.verifyPermit({
    permitId: args.permitId,
    ...(args.agent !== undefined ? { agent: args.agent } : {}),
    ...(args.action !== undefined ? { action: args.action } : {}),
    ...(args.context !== undefined ? { context: args.context } : {}),
  });
}

export async function toolKeySelf(
  client: AtlaSentClient,
): Promise<ApiKeySelfResponse> {
  return client.keySelf();
}

// ── error serialisation ────────────────────────────────────────────────────

/** Converts any thrown value to a human-readable error string for MCP. */
export function formatError(err: unknown): string {
  if (err instanceof AtlaSentDeniedError) {
    return `DENIED [${err.evaluationId}]: ${err.reason}`;
  }
  if (err instanceof AtlaSentError) {
    return `AtlaSentError(${err.code}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
