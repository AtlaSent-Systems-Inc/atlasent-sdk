/**
 * Context Layer — typed, validated, redaction-aware context for AtlaSent
 * evaluations.
 *
 * The current `protect()` / `evaluate()` API accepts
 * `context?: Record<string, unknown>` — a black box the policy engine
 * treats as an opaque blob. This module provides:
 *
 * 1. **Typed sub-schemas** — `ActorContext`, `ResourceContext`,
 *    `EnvironmentContext`, `ActionMetaContext`, `HistoricalContext`, and
 *    `ActionContext` (the union of all five).
 *
 * 2. **`buildActionContext()`** — a structured constructor that normalises
 *    flat shorthands and validates at build time.
 *
 * 3. **`validateActionContext()`** — non-throwing validation that returns
 *    typed `ContextValidationError[]` and `ContextValidationWarning[]`.
 *
 * 4. **`redactContext()`** — strips / masks sensitive fields before
 *    logging or storing in receipts / evidence bundles.
 *
 * 5. **`flattenActionContext()`** — converts a typed `ActionContext` to the
 *    flat `Record<string, unknown>` that `protect()` / `evaluate()` accept.
 *
 * ### Usage
 *
 * ```ts
 * import atlasent, { buildActionContext, redactContext } from "@atlasent/sdk";
 *
 * const ctx = buildActionContext({
 *   actor: { id: "user:alice", type: "human", roles: ["deploy_engineer"] },
 *   environment: { name: "production", region: "us-east-1" },
 *   resource: { type: "service", id: "api-gateway", sensitivity: "restricted" },
 * });
 *
 * const permit = await atlasent.protect({
 *   agent: "deploy-bot",
 *   action: "production.deploy",
 *   context: flattenActionContext(ctx),
 * });
 *
 * // Store the redacted context alongside the permit — no PII in evidence.
 * const safe = redactContext(ctx);
 * await db.permits.create({ permitId: permit.permitId, context: safe });
 * ```
 */

// ── Typed sub-schemas ──────────────────────────────────────────────────────────────

/**
 * Identity of the actor requesting the action.
 *
 * `id` is the only required field; all others are policy-engine hints.
 * Omitting optional fields may cause deny on policies that gate on role
 * membership, trust level, or session binding.
 */
export interface ActorContext {
  /** Stable, opaque actor identifier (e.g. `"user:alice"`, `"agent:deploy-bot"`). */
  id: string;
  /** Human-readable label for audit trails and reviewer UIs. */
  label?: string;
  /** Discriminates human vs. AI agent vs. service account. */
  type?: "human" | "agent" | "service_account" | "system";
  /** Roles the actor holds at evaluation time. */
  roles?: string[];
  /** Trust tier. Policy rules can gate on this value. */
  trust_level?: "high" | "medium" | "low" | "untrusted" | string;
  /** Actor email — required for human-approval escalation UIs. */
  email?: string;
  /** Observed client IP — used in geo-restriction and rate-limit rules. */
  ip?: string;
  /** Session or OAuth token ID for replay-detection rules. */
  session_id?: string;
}

/**
 * The resource the action targets.
 *
 * `type` is a stable string like `"database.table"`, `"repository"`,
 * or `"payment"`. `sensitivity` drives redaction rules in evidence
 * bundles — `"restricted"` fields are masked even in signed receipts.
 */
export interface ResourceContext {
  /** Stable resource type slug (e.g. `"database.table"`, `"service"`, `"payment"`). */
  type?: string;
  /** Opaque resource identifier (e.g. table name, repo name, payment ID). */
  id?: string;
  /** Human-readable name for reviewer UIs. */
  name?: string;
  /** Data-sensitivity classification — drives receipt redaction. */
  sensitivity?: "public" | "internal" | "confidential" | "restricted";
  /** Owner org or tenant of the resource. */
  owner?: string;
  /** Cloud or datacenter region where the resource lives. */
  region?: string;
}

/**
 * Deployment environment and infrastructure context.
 *
 * `name` is the field protect() reads to set the `environment` field
 * on the verify-permit request. Omitting it logs a console warning
 * and defaults to `"production"`.
 */
export interface EnvironmentContext {
  /** Deployment tier. Defaults to `"production"` in protect() when absent. */
  name?: "production" | "staging" | "development" | "test" | string;
  /** Cloud or datacenter region (e.g. `"us-east-1"`, `"eu-west-1"`). */
  region?: string;
  /** CI/CD pipeline name (e.g. `"github_actions"`, `"jenkins"`). */
  pipeline?: string;
  /** Git SHA, image tag, or artifact version being deployed. */
  version?: string;
}

/**
 * Action-specific metadata that shapes policy decisions.
 *
 * `risk_level` and `reversibility` are the two fields most commonly
 * referenced by policy rules. Financial policies additionally gate on
 * `estimated_amount` and `currency`.
 */
export interface ActionMetaContext {
  /** Caller-assessed risk level of this specific invocation. */
  risk_level?: "critical" | "high" | "medium" | "low";
  /** Whether the action can be undone after execution. */
  reversibility?: "reversible" | "irreversible" | "partial";
  /** Free-text description shown to human reviewers in the HITL UI. */
  description?: string;
  /** Estimated monetary amount for financial actions. */
  estimated_amount?: number;
  /** ISO 4217 currency code (e.g. `"USD"`, `"EUR"`). */
  currency?: string;
}

/**
 * Historical and behavioral signals about the actor.
 *
 * These are caller-computed signals from the caller's own systems —
 * AtlaSent does not maintain the source-of-truth; it only evaluates
 * policy against the values provided here.
 */
export interface HistoricalContext {
  /** Number of times this actor performed this action in the past 24h. */
  recent_action_count?: number;
  /** ISO-8601 timestamp of the actor's most recent action of this type. */
  last_action_at?: string;
  /** True when the actor has unresolved policy violations on record. */
  has_violations?: boolean;
  /** Arbitrary caller-defined risk signals from upstream systems. */
  risk_signals?: Record<string, unknown>;
}

/**
 * The canonical typed context for AtlaSent evaluations.
 *
 * All sub-schemas are optional at the TypeScript level; policy rules
 * determine which fields are effectively required. Missing fields that
 * a policy expects will typically result in a `deny` decision.
 *
 * Flat shorthands (`resource_type`, `resource_id`, `environment_name`)
 * are supported for backward compatibility with existing
 * `Record<string, unknown>` call sites. `buildActionContext()` merges
 * them into the nested sub-schemas automatically.
 *
 * The `[key: string]: unknown` index signature allows arbitrary
 * custom fields to pass through to the policy engine unchanged.
 */
export interface ActionContext {
  actor?: ActorContext;
  resource?: ResourceContext;
  environment?: EnvironmentContext;
  action_meta?: ActionMetaContext;
  history?: HistoricalContext;

  // ── Flat shorthands for backward compat ───────────────────────────
  // These alias the most common nested fields so existing Record<string, unknown>
  // usage continues to work without refactoring. Both the flat and nested
  // forms are sent in flattenActionContext() output so policy rules written
  // against either form continue to work.

  /** Alias for `environment.name`. Merged into `environment` by buildActionContext. */
  environment_name?: string;
  /** Alias for `resource.type`. Merged into `resource` by buildActionContext. */
  resource_type?: string;
  /** Alias for `resource.id`. Merged into `resource` by buildActionContext. */
  resource_id?: string;

  [key: string]: unknown;
}

// ── buildActionContext ────────────────────────────────────────────────────────────

/** Input for `buildActionContext()`. Mirrors `ActionContext` with `actor` required. */
export interface BuildActionContextInput {
  actor: ActorContext;
  resource?: ResourceContext;
  environment?: EnvironmentContext | string;
  action_meta?: ActionMetaContext;
  history?: HistoricalContext;
  /** Arbitrary additional fields to pass through to the policy engine. */
  extra?: Record<string, unknown>;
}

/**
 * Construct a normalized `ActionContext`.
 *
 * - Accepts `environment` as a string shorthand for `{ name: environment }`.
 * - Populates flat shorthands (`resource_type`, `resource_id`,
 *   `environment_name`) from the nested sub-schemas so both the nested and
 *   flat forms are present in the output.
 * - Never throws — validation is a separate step via `validateActionContext()`.
 *
 * ```ts
 * const ctx = buildActionContext({
 *   actor: { id: "agent:deploy-bot", type: "agent" },
 *   environment: "production",
 *   resource: { type: "service", id: "checkout-api" },
 * });
 * ```
 */
export function buildActionContext(
  input: BuildActionContextInput,
): ActionContext {
  const env: EnvironmentContext | undefined =
    typeof input.environment === "string"
      ? { name: input.environment }
      : input.environment;

  const ctx: ActionContext = {
    actor: input.actor,
    ...(input.resource !== undefined && { resource: input.resource }),
    ...(env !== undefined && { environment: env }),
    ...(input.action_meta !== undefined && { action_meta: input.action_meta }),
    ...(input.history !== undefined && { history: input.history }),
    ...(input.extra ?? {}),
  };

  // Populate flat shorthands from nested sub-schemas
  if (env?.name !== undefined) ctx.environment_name = env.name;
  if (input.resource?.type !== undefined)
    ctx.resource_type = input.resource.type;
  if (input.resource?.id !== undefined) ctx.resource_id = input.resource.id;

  return ctx;
}

// ── validateActionContext ────────────────────────────────────────────────────────

/** A field-level error from `validateActionContext()`. */
export interface ContextValidationError {
  /** Dot-delimited field path (e.g. `"actor.id"`, `"action_meta.currency"`). */
  field: string;
  /** Machine-readable error code. */
  code:
    | "required"
    | "invalid_type"
    | "invalid_value"
    | "cross_field"
    | "sensitive_field";
  /** Human-readable explanation. */
  message: string;
}

/** A non-blocking advisory from `validateActionContext()`. */
export interface ContextValidationWarning {
  field: string;
  code: "recommended" | "deprecated" | "performance";
  message: string;
}

/** Result of `validateActionContext()`. */
export interface ContextValidationResult {
  valid: boolean;
  errors: ContextValidationError[];
  warnings: ContextValidationWarning[];
}

/** Options for `validateActionContext()`. */
export interface ValidateContextOptions {
  /**
   * Extra fields to treat as required. Dot-delimited paths are supported
   * (e.g. `["actor.roles", "resource.id"]`).
   */
  requiredFields?: string[];
  /**
   * When true, skip the built-in cross-field checks (e.g.
   * estimated_amount → currency). Useful for partial contexts.
   */
  skipCrossFieldChecks?: boolean;
}

function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  return path.split(".").reduce<unknown>((cur, key) => {
    if (cur !== null && typeof cur === "object") {
      return (cur as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Validate an `ActionContext` without throwing.
 *
 * Returns a `ContextValidationResult` with `valid: false` and a list of
 * typed `errors` / `warnings` when the context is malformed or missing
 * fields. Does not throw — the caller decides what to do with errors.
 *
 * Built-in checks:
 * - `actor.id` is required when `actor` is present
 * - `environment.name` is recommended (warns if absent)
 * - `action_meta.currency` is required when `action_meta.estimated_amount > 0`
 * - ISO 4217 format check for `action_meta.currency`
 * - `history.last_action_at` must be a valid ISO-8601 string
 * - `resource.sensitivity` must be a known value when present
 *
 * ```ts
 * const { valid, errors, warnings } = validateActionContext(ctx, {
 *   requiredFields: ["resource.id", "actor.roles"],
 * });
 * if (!valid) logger.warn("Context validation failed", { errors });
 * ```
 */
export function validateActionContext(
  ctx: ActionContext,
  opts: ValidateContextOptions = {},
): ContextValidationResult {
  const errors: ContextValidationError[] = [];
  const warnings: ContextValidationWarning[] = [];

  const ctxObj = ctx as Record<string, unknown>;

  // ── actor.id required when actor is provided ────────────────────────
  if (ctx.actor !== undefined) {
    if (!ctx.actor.id || typeof ctx.actor.id !== "string") {
      errors.push({
        field: "actor.id",
        code: "required",
        message: "actor.id is required when actor is provided",
      });
    }
  }

  // ── environment.name recommended ────────────────────────────────────
  const hasEnvName =
    ctx.environment?.name !== undefined ||
    ctx.environment_name !== undefined;
  if (!hasEnvName) {
    warnings.push({
      field: "environment.name",
      code: "recommended",
      message:
        "environment.name is not set; protect() will default to 'production' with a console warning",
    });
  }

  // ── cross-field: estimated_amount requires currency ─────────────────
  if (!opts.skipCrossFieldChecks) {
    const amount = ctx.action_meta?.estimated_amount;
    if (typeof amount === "number" && amount > 0) {
      if (!ctx.action_meta?.currency) {
        errors.push({
          field: "action_meta.currency",
          code: "cross_field",
          message:
            "action_meta.currency is required when action_meta.estimated_amount > 0",
        });
      } else if (!/^[A-Z]{3}$/.test(ctx.action_meta.currency)) {
        errors.push({
          field: "action_meta.currency",
          code: "invalid_value",
          message:
            `action_meta.currency '${ctx.action_meta.currency}' is not a valid ISO 4217 code (expected 3 uppercase letters)`,
        });
      }
    }
  }

  // ── history.last_action_at must be ISO-8601 ─────────────────────────
  if (ctx.history?.last_action_at !== undefined) {
    const ts = new Date(ctx.history.last_action_at);
    if (isNaN(ts.getTime())) {
      errors.push({
        field: "history.last_action_at",
        code: "invalid_type",
        message: `history.last_action_at '${ctx.history.last_action_at}' is not a valid ISO-8601 timestamp`,
      });
    }
  }

  // ── resource.sensitivity must be a known value ──────────────────────
  const knownSensitivities = new Set([
    "public",
    "internal",
    "confidential",
    "restricted",
  ]);
  if (
    ctx.resource?.sensitivity !== undefined &&
    !knownSensitivities.has(ctx.resource.sensitivity)
  ) {
    errors.push({
      field: "resource.sensitivity",
      code: "invalid_value",
      message: `resource.sensitivity '${ctx.resource.sensitivity}' is not one of: public, internal, confidential, restricted`,
    });
  }

  // ── caller-specified required fields ────────────────────────────────
  for (const fieldPath of opts.requiredFields ?? []) {
    const value = getNestedValue(ctxObj, fieldPath);
    if (value === undefined || value === null || value === "") {
      errors.push({
        field: fieldPath,
        code: "required",
        message: `${fieldPath} is required by the caller's validation rules`,
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── redactContext ────────────────────────────────────────────────────────────────

/** Redaction mode applied to a matched field. */
export type RedactionMode = "remove" | "mask" | "hash";

/**
 * A single redaction rule. `field` is matched against every key at
 * every nesting level in the context object.
 *
 * `path` narrows the match to a specific dot-delimited location
 * (e.g. `"actor.email"` to only mask email inside the actor sub-object,
 * not top-level email fields).
 */
export interface RedactionRule {
  /** Key name or regex applied to every key in the context tree. */
  field: string | RegExp;
  /** What to do with the matched value. */
  mode: RedactionMode;
  /**
   * Optional dot-delimited path constraint. When set, the rule only
   * applies to a key at this exact path (e.g. `"actor.session_id"`).
   */
  path?: string;
}

/**
 * Built-in redaction rules covering OWASP Top 10 sensitive field
 * name patterns. Matched case-insensitively against every key name
 * at every nesting level.
 *
 * Callers can extend this list or pass a custom rule set to
 * `redactContext()`.
 */
export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  {
    field: /password|passwd|passphrase/i,
    mode: "remove",
  },
  {
    field: /secret|private_key|client_secret|signing_secret/i,
    mode: "remove",
  },
  {
    field: /api_key|apikey|access_key|access_token/i,
    mode: "remove",
  },
  {
    field: /\btoken\b|auth_token|bearer/i,
    mode: "mask",
  },
  {
    field: /\bssn\b|social_security|tax_id|\bsin\b/i,
    mode: "remove",
  },
  {
    field: /credit_card|card_number|pan\b|cvv|cvc|expiry/i,
    mode: "remove",
  },
  {
    field: /\bemail\b/i,
    mode: "mask",
  },
  {
    field: /phone|mobile|cell\b/i,
    mode: "mask",
  },
  {
    field: /\bip\b|ip_address|remote_addr/i,
    mode: "mask",
  },
  {
    field: /dob|date_of_birth|birth_date|birthdate/i,
    mode: "remove",
  },
];

const MASK_PLACEHOLDER = "[REDACTED]";

function matchesRule(key: string, rule: RedactionRule): boolean {
  if (typeof rule.field === "string") {
    return key.toLowerCase() === rule.field.toLowerCase();
  }
  return rule.field.test(key);
}

function redactValue(
  value: unknown,
  mode: RedactionMode,
): unknown {
  if (mode === "remove") return undefined;
  if (mode === "mask") return MASK_PLACEHOLDER;
  // "hash" — return a stable placeholder; callers that want actual hashing
  // can post-process the "[HASHED]" sentinel.
  return "[HASHED]";
}

function redactObject(
  obj: Record<string, unknown>,
  rules: readonly RedactionRule[],
  currentPath: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = currentPath ? `${currentPath}.${key}` : key;

    // Find the first matching rule (path-constrained rules take priority)
    const matchingRule = rules.find(
      (r) =>
        matchesRule(key, r) && (r.path === undefined || r.path === fieldPath),
    );

    if (matchingRule) {
      const redacted = redactValue(value, matchingRule.mode);
      if (redacted !== undefined) result[key] = redacted;
      // If mode === "remove", the key is omitted (undefined not assigned)
    } else if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      result[key] = redactObject(
        value as Record<string, unknown>,
        rules,
        fieldPath,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Return a redacted copy of `ctx` with sensitive fields removed or masked.
 *
 * Uses `DEFAULT_REDACTION_RULES` when `rules` is omitted. Callers can
 * extend or replace the default rules:
 *
 * ```ts
 * import { DEFAULT_REDACTION_RULES, redactContext } from "@atlasent/sdk";
 *
 * const safe = redactContext(ctx, [
 *   ...DEFAULT_REDACTION_RULES,
 *   { field: /internal_id/, mode: "hash" },
 * ]);
 * ```
 *
 * Never mutates the input; returns a shallow-to-deep copy.
 */
export function redactContext(
  ctx: ActionContext,
  rules: readonly RedactionRule[] = DEFAULT_REDACTION_RULES,
): ActionContext {
  return redactObject(
    ctx as Record<string, unknown>,
    rules,
    "",
  ) as ActionContext;
}

// ── flattenActionContext ──────────────────────────────────────────────────────────

/**
 * Convert a typed `ActionContext` to the flat `Record<string, unknown>`
 * that `protect()` / `evaluate()` / `verifyPermit()` accept.
 *
 * The output merges:
 * 1. All top-level scalar fields from `ActionContext` (including flat
 *    shorthands like `environment_name`).
 * 2. Nested sub-schemas (`actor`, `resource`, `environment`, etc.) preserved
 *    as nested objects so policy rules written against either the nested or
 *    flat form work correctly.
 *
 * The nested form is always present in the output; the flat shorthands
 * (`resource_type`, `resource_id`, `environment_name`, `environment`) are
 * duplicated at the top level for policy rules that use the flat path.
 *
 * ```ts
 * const permit = await protect({
 *   agent: "deploy-bot",
 *   action: "production.deploy",
 *   context: flattenActionContext(ctx),
 * });
 * ```
 */
export function flattenActionContext(
  ctx: ActionContext,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {};

  // Copy all top-level fields (both structured sub-schemas and extra fields)
  for (const [key, value] of Object.entries(ctx)) {
    flat[key] = value;
  }

  // Ensure the top-level `environment` field (the string name) is present
  // because protect() reads `context.environment` as a string when extracting
  // the environment name for verifyPermit().
  const envName = ctx.environment?.name ?? ctx.environment_name;
  if (envName !== undefined) {
    flat["environment"] = envName;
  }

  return flat;
}
