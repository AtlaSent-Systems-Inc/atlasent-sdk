/**
 * Trajectory authorization helpers for the AtlaSent TypeScript SDK.
 *
 * These utilities expose the trajectory-authorization workflow as first-class
 * SDK primitives, building on the core EvaluateRequest / EvaluateResponse types.
 */

import type {
  AtlaSentClientOptions,
  EvaluateRequest,
  EvaluateResponse,
  TrajectoryDeviationEvent,
} from "./types.js";

export type {
  StateSnapshot,
  TrajectoryStep,
  ProposedTrajectory,
  AuthorizedTrajectory,
  TrajectoryVerifyRequest,
  TrajectoryVerifyResponse,
  TrajectoryDeviationEvent,
  TrajectoryDeviationType,
  ComplianceComparisonArtifact,
} from "./types.js";

/**
 * Build an `EvaluateRequest` enriched with trajectory fields.
 * Convenience wrapper — merges base fields with trajectory-specific fields.
 */
export function buildTrajectoryRequest(
  params: EvaluateRequest
): EvaluateRequest {
  return { ...params };
}

/**
 * Extract the `authorized_trajectory` from an `EvaluateResponse`, or `null`
 * if the response does not include one.
 */
export function getAuthorizedTrajectory(
  response: EvaluateResponse
): EvaluateResponse["authorized_trajectory"] | null {
  return response.authorized_trajectory ?? null;
}

/**
 * Type guard: returns `true` iff the response contains an `authorized_trajectory`.
 *
 * ```ts
 * if (hasAuthorizedTrajectory(response)) {
 *   const { steps } = response.authorized_trajectory;
 * }
 * ```
 */
export function hasAuthorizedTrajectory(
  response: EvaluateResponse
): response is EvaluateResponse & {
  authorized_trajectory: NonNullable<EvaluateResponse["authorized_trajectory"]>;
} {
  return response.authorized_trajectory != null;
}

/**
 * Call `POST /v1/trajectory-verify` for a single execution step.
 *
 * Pass the permit token from the original `evaluate()` response and the
 * current step identifier. The server returns whether the step is on the
 * authorized trajectory and, if not, a `TrajectoryDeviationEvent`.
 *
 * Throws `TrajectoryDeviationError` when `on_trajectory` is `false` and
 * `throwOnDeviation` is `true` (the default).
 */
export async function verifyTrajectoryStep(
  options: AtlaSentClientOptions & { throwOnDeviation?: boolean },
  request: {
    permit_token: string;
    current_step: string;
    current_state?: { description: string; attributes?: Record<string, unknown>; fingerprint?: string };
    completed_steps?: string[];
    execution_context?: Record<string, unknown>;
  },
  fetchImpl?: typeof fetch
): Promise<{
  on_trajectory: boolean;
  trajectory_position?: number;
  trajectory_complete: boolean;
  deviation?: TrajectoryDeviationEvent;
  verified_at: string;
}> {
  const fetcher = fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "https://api.atlasent.io";

  const response = await fetcher(`${baseUrl}/v1/trajectory-verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });

  if (!response.ok) {
    throw new Error(
      `trajectory-verify failed: ${response.status} ${response.statusText}`
    );
  }

  type VerifyResult = {
    on_trajectory: boolean;
    trajectory_position?: number;
    trajectory_complete: boolean;
    deviation?: TrajectoryDeviationEvent;
    verified_at: string;
  };
  const result = (await response.json()) as VerifyResult;

  if ((options.throwOnDeviation ?? true) && result.on_trajectory === false) {
    throw new TrajectoryDeviationError(
      result.deviation?.reason ??
        `Step '${request.current_step}' is not on the authorized trajectory`,
      result.deviation,
      result.deviation?.trajectory_id,
      result.deviation?.permit_id
    );
  }

  return result;
}

/**
 * Thrown by `verifyTrajectoryStep` (with `throwOnDeviation: true`) when a
 * step is not on the authorized trajectory.
 *
 * Carries the full `TrajectoryDeviationEvent` so the caller can record it
 * in the `ComplianceComparisonArtifact`.
 */
export class TrajectoryDeviationError extends Error {
  readonly deviation: unknown;
  readonly trajectoryId: string | undefined;
  readonly permitId: string | undefined;

  constructor(
    message: string,
    deviation: unknown,
    trajectoryId?: string,
    permitId?: string
  ) {
    super(message);
    this.name = "TrajectoryDeviationError";
    this.deviation = deviation;
    this.trajectoryId = trajectoryId;
    this.permitId = permitId;
  }
}
