/**
 * Clinical trial blinding/unblinding types — wire shapes for `v1-clinical-unblind`.
 *
 * Supports ICH E6(R2) §4.8 / 21 CFR Part 11 §11.10(a) / §11.50 / §11.300
 * execution-time authorization of clinical trial unblinding operations.
 * The blinding state machine is append-only; each transition produces an
 * immutable {@link ClinicalUnblindingEvent} in the audit ledger.
 */

// Status values matching the DB CHECK constraint on `clinical_trial_blinds.status`.
export type ClinicalBlindingStatus =
  | 'blinded'
  | 'unblinding_in_progress'
  | 'unblinded'
  | 'emergency_unblinded'
  | 'suspended';

/**
 * A clinical trial blinding record.
 * Returned by GET list and GET ?trial_id=X.
 */
export interface ClinicalTrialBlind {
  id: string;
  org_id: string;
  trial_id: string;
  trial_name: string;
  protocol_number: string | null;
  phase: string | null;
  blinding_type: string;
  status: ClinicalBlindingStatus;
  established_by: string;
  established_evaluation_id: string | null;
  sponsor_org: string | null;
  randomization_code_hash: string;
  created_at: string;
  unblinded_by: string | null;
  unblinded_at: string | null;
  unblinding_evaluation_id: string | null;
  emergency_unblinded_by: string | null;
  emergency_unblinded_at: string | null;
  suspended_at: string | null;
  suspended_by: string | null;
}

/**
 * A single audit event from the clinical unblinding ledger.
 * Returned by GET /history. Append-only — corrections are new events.
 */
export interface ClinicalUnblindingEvent {
  id: string;
  org_id: string;
  trial_id: string;
  blind_id: string;
  event_type:
    | 'blind_established'
    | 'unblinding_initiated'
    | 'unblinding_executed'
    | 'emergency_unblinding_executed'
    | 'blinding_reinstated'
    | 'suspended'
    | 'reinstated';
  actor_id: string;
  evaluation_id: string | null;
  permit_token_hash: string | null;
  reason: string;
  /** §11.50(a)(2) electronic signature meaning text. */
  approval_meaning: string | null;
  subject_ids: string[] | null;
  emergency: boolean;
  unblinding_scope: string;
  occurred_at: string;
  metadata: Record<string, unknown> | null;
}

/**
 * POST /blind request — establish a new blinding record for a clinical trial.
 */
export interface ClinicalBlindRequest {
  trial_id: string;
  trial_name: string;
  phase: string;
  blinding_type: string;
  /** SHA-256 hex hash of the randomization code. Never the code itself. */
  randomization_code_hash: string;
  established_by: string;
  reason: string;
  protocol_number?: string;
  evaluation_id?: string;
  /** §11.50(a)(2) electronic signature meaning. */
  approval_meaning?: string;
  sponsor_org?: string;
}

/** POST /blind response. */
export interface ClinicalBlindResponse {
  blind: ClinicalTrialBlind;
}

/**
 * POST /unblind request.
 * Server requires `approval_meaning` ≥ 20 chars (§11.50(a)(2)).
 */
export interface ClinicalUnblindRequest {
  trial_id: string;
  actor_id: string;
  reason: string;
  /** §11.50(a)(2) electronic signature meaning; server requires ≥ 20 characters. */
  approval_meaning: string;
  evaluation_id?: string;
  permit_token_hash?: string;
  /** Scope of unblinding (e.g. `"full"`, `"partial"`, `"individual"`). */
  unblinding_scope?: string;
  /** DSMB authorization reference for audit trail. */
  dsmb_authorization_ref?: string;
}

/**
 * POST /emergency request — ICH E6(R2) §4.8 individual-patient emergency unblinding.
 */
export interface ClinicalEmergencyRequest {
  trial_id: string;
  actor_id: string;
  subject_id: string;
  emergency_justification: string;
  evaluation_id?: string;
  permit_token_hash?: string;
  /** §11.50(a)(2) electronic signature meaning. */
  approval_meaning?: string;
}

/**
 * Response body for POST /unblind and POST /emergency.
 */
export interface ClinicalMutationResponse {
  success: boolean;
  trial_id: string;
  status?: ClinicalBlindingStatus;
  /** Present on emergency unblinding — the affected subject identifier. */
  subject_id?: string;
  event_type?: string;
  unblinded_by?: string;
  unblinded_at?: string;
  occurred_at?: string;
  evaluation_id?: string | null;
}

/** GET list response. */
export interface ClinicalTrialListResponse {
  trials: ClinicalTrialBlind[];
}

/** GET ?trial_id=X response. */
export interface ClinicalTrialGetResponse {
  trial: ClinicalTrialBlind;
}

/** GET /history response. */
export interface ClinicalHistoryResponse {
  events: ClinicalUnblindingEvent[];
}

/** POST /verify-permit request. */
export interface ClinicalVerifyPermitRequest {
  trial_id: string;
  permit_token: string;
  /** One of the clinical action classes. */
  action_type:
    | "trial.blinding.setup"
    | "trial.unblinding.execute"
    | "trial.unblinding.emergency";
  actor_id: string;
}

/** POST /verify-permit result (as returned by the permit verifier). */
export interface ClinicalVerifyPermitResult {
  valid?: boolean;
  outcome?: string;
  verify_error_code?: string;
  reason?: string;
}

/** Optional filters for {@link ClinicalTrialsSubClient.list}. */
export interface ClinicalTrialListQuery {
  status?: ClinicalBlindingStatus;
  limit?: number;
  offset?: number;
}

/**
 * Client for the clinical trial blinding/unblinding gate
 * (`v1-clinical-unblind`, public path `/v1/clinical-unblind`). Reads require
 * the `clinical:read` scope; writes require `clinical:manage`.
 */
export interface ClinicalTrialsSubClient {
  list(query?: ClinicalTrialListQuery): Promise<ClinicalTrialListResponse>;
  get(trialId: string): Promise<ClinicalTrialGetResponse>;
  history(trialId: string): Promise<ClinicalHistoryResponse>;
  blind(request: ClinicalBlindRequest): Promise<ClinicalBlindResponse>;
  requestUnblind(request: ClinicalUnblindRequest): Promise<ClinicalMutationResponse>;
  emergencyUnblind(request: ClinicalEmergencyRequest): Promise<ClinicalMutationResponse>;
  verifyPermit(request: ClinicalVerifyPermitRequest): Promise<ClinicalVerifyPermitResult>;
}

const CLINICAL_BASE = "/v1/clinical-unblind";

/**
 * Build the clinical-trials sub-client from the host client's request
 * primitives. Mirrors the other `make*Client` factories.
 */
export function makeClinicalTrialsClient(
  getFn: <T>(path: string, query?: URLSearchParams) => Promise<{ body: T }>,
  postFn: <T>(path: string, body: unknown) => Promise<{ body: T }>,
): ClinicalTrialsSubClient {
  return {
    async list(query = {}) {
      const sp = new URLSearchParams();
      if (query.status) sp.set("status", query.status);
      if (query.limit != null) sp.set("limit", String(query.limit));
      if (query.offset != null) sp.set("offset", String(query.offset));
      const qs = [...sp].length ? sp : undefined;
      const { body } = await getFn<ClinicalTrialListResponse>(CLINICAL_BASE, qs);
      return body;
    },

    async get(trialId: string) {
      const sp = new URLSearchParams({ trial_id: trialId });
      const { body } = await getFn<ClinicalTrialGetResponse>(CLINICAL_BASE, sp);
      return body;
    },

    async history(trialId: string) {
      const sp = new URLSearchParams({ trial_id: trialId });
      const { body } = await getFn<ClinicalHistoryResponse>(`${CLINICAL_BASE}/history`, sp);
      return body;
    },

    async blind(request: ClinicalBlindRequest) {
      const { body } = await postFn<ClinicalBlindResponse>(`${CLINICAL_BASE}/blind`, request);
      return body;
    },

    async requestUnblind(request: ClinicalUnblindRequest) {
      const { body } = await postFn<ClinicalMutationResponse>(`${CLINICAL_BASE}/unblind`, request);
      return body;
    },

    async emergencyUnblind(request: ClinicalEmergencyRequest) {
      const { body } = await postFn<ClinicalMutationResponse>(`${CLINICAL_BASE}/emergency`, request);
      return body;
    },

    async verifyPermit(request: ClinicalVerifyPermitRequest) {
      const { body } = await postFn<ClinicalVerifyPermitResult>(
        `${CLINICAL_BASE}/verify-permit`,
        request,
      );
      return body;
    },
  };
}
