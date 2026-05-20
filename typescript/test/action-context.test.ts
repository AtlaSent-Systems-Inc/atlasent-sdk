import { describe, it, expect } from "vitest";
import {
  buildActionContext,
  validateActionContext,
  redactContext,
  flattenActionContext,
  DEFAULT_REDACTION_RULES,
} from "../src/actionContext.js";

// ── buildActionContext ──────────────────────────────────────────────────────

describe("buildActionContext", () => {
  it("converts string environment to {name: string}", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
    });
    expect(ctx.environment).toEqual({ name: "production" });
  });

  it("passes object environment through unchanged", () => {
    const env = { name: "staging", region: "us-east-1" };
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: env,
    });
    expect(ctx.environment).toEqual(env);
  });

  it("populates environment_name shorthand from object environment", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: { name: "development", pipeline: "github_actions" },
    });
    expect(ctx.environment_name).toBe("development");
  });

  it("populates environment_name shorthand from string environment", () => {
    const ctx = buildActionContext({
      actor: { id: "agent:deploy-bot" },
      environment: "staging",
    });
    expect(ctx.environment_name).toBe("staging");
  });

  it("populates resource_type and resource_id shorthands", () => {
    const ctx = buildActionContext({
      actor: { id: "user:bob" },
      resource: { type: "database.table", id: "orders" },
    });
    expect(ctx.resource_type).toBe("database.table");
    expect(ctx.resource_id).toBe("orders");
  });

  it("does not set resource_type / resource_id when resource absent", () => {
    const ctx = buildActionContext({ actor: { id: "user:bob" } });
    expect(ctx.resource_type).toBeUndefined();
    expect(ctx.resource_id).toBeUndefined();
  });

  it("includes action_meta when provided", () => {
    const meta = { risk_level: "high" as const, reversibility: "irreversible" as const };
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      action_meta: meta,
    });
    expect(ctx.action_meta).toEqual(meta);
  });

  it("includes history when provided", () => {
    const history = { recent_action_count: 3, has_violations: false };
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      history,
    });
    expect(ctx.history).toEqual(history);
  });

  it("merges extra fields into the top level", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      extra: { custom_field: "hello", risk_score: 42 },
    });
    expect(ctx.custom_field).toBe("hello");
    expect(ctx.risk_score).toBe(42);
  });

  it("handles minimal input with only actor", () => {
    const ctx = buildActionContext({ actor: { id: "user:min" } });
    expect(ctx.actor).toEqual({ id: "user:min" });
    expect(ctx.environment).toBeUndefined();
    expect(ctx.resource).toBeUndefined();
    expect(ctx.action_meta).toBeUndefined();
    expect(ctx.history).toBeUndefined();
    expect(ctx.environment_name).toBeUndefined();
    expect(ctx.resource_type).toBeUndefined();
    expect(ctx.resource_id).toBeUndefined();
  });

  it("does not set resource_type when resource has no type", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      resource: { id: "repo-123" },
    });
    expect(ctx.resource_type).toBeUndefined();
    expect(ctx.resource_id).toBe("repo-123");
  });

  it("does not set environment_name when environment has no name", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: { region: "eu-west-1" },
    });
    expect(ctx.environment_name).toBeUndefined();
    expect(ctx.environment).toEqual({ region: "eu-west-1" });
  });
});

// ── validateActionContext ──────────────────────────────────────────────────

describe("validateActionContext", () => {
  it("returns valid=true for a well-formed context", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice", type: "human" },
      environment: "production",
      resource: { type: "service", id: "api-gw", sensitivity: "internal" },
    });
    const result = validateActionContext(ctx);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("warns (not errors) when environment.name is absent", () => {
    const ctx = buildActionContext({ actor: { id: "user:alice" } });
    const result = validateActionContext(ctx);
    // valid because no errors — but there IS a warning
    expect(result.valid).toBe(true);
    const warn = result.warnings.find((w) => w.field === "environment.name");
    expect(warn).toBeDefined();
    expect(warn?.code).toBe("recommended");
  });

  it("no warning for environment.name when environment_name shorthand is set", () => {
    const ctx: import("../src/actionContext.js").ActionContext = {
      actor: { id: "user:alice" },
      environment_name: "staging",
    };
    const result = validateActionContext(ctx);
    const warn = result.warnings.find((w) => w.field === "environment.name");
    expect(warn).toBeUndefined();
  });

  it("errors when actor is present but actor.id is missing", () => {
    const ctx: import("../src/actionContext.js").ActionContext = {
      actor: { id: "" }, // empty string treated as missing
      environment: { name: "production" },
    };
    const result = validateActionContext(ctx);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "actor.id");
    expect(err).toBeDefined();
    expect(err?.code).toBe("required");
  });

  it("errors when estimated_amount > 0 but currency is absent", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
      action_meta: { estimated_amount: 500 },
    });
    const result = validateActionContext(ctx);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "action_meta.currency");
    expect(err).toBeDefined();
    expect(err?.code).toBe("cross_field");
  });

  it("does not error when estimated_amount === 0 and currency absent", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
      action_meta: { estimated_amount: 0 },
    });
    const result = validateActionContext(ctx);
    const err = result.errors.find((e) => e.field === "action_meta.currency");
    expect(err).toBeUndefined();
  });

  it("errors when currency is not a valid ISO 4217 code", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
      action_meta: { estimated_amount: 100, currency: "dollars" },
    });
    const result = validateActionContext(ctx);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "action_meta.currency");
    expect(err).toBeDefined();
    expect(err?.code).toBe("invalid_value");
  });

  it("accepts a valid ISO 4217 currency code", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
      action_meta: { estimated_amount: 100, currency: "EUR" },
    });
    const result = validateActionContext(ctx);
    const err = result.errors.find((e) => e.field === "action_meta.currency");
    expect(err).toBeUndefined();
  });

  it("errors when history.last_action_at is not a valid ISO-8601 timestamp", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
      history: { last_action_at: "not-a-date" },
    });
    const result = validateActionContext(ctx);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "history.last_action_at");
    expect(err).toBeDefined();
    expect(err?.code).toBe("invalid_type");
  });

  it("accepts a valid ISO-8601 timestamp for history.last_action_at", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
      history: { last_action_at: "2025-01-15T12:30:00Z" },
    });
    const result = validateActionContext(ctx);
    const err = result.errors.find((e) => e.field === "history.last_action_at");
    expect(err).toBeUndefined();
  });

  it("errors when resource.sensitivity is an unknown value", () => {
    const ctx: import("../src/actionContext.js").ActionContext = {
      actor: { id: "user:alice" },
      environment: { name: "production" },
      resource: { sensitivity: "top_secret" as "restricted" },
    };
    const result = validateActionContext(ctx);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "resource.sensitivity");
    expect(err).toBeDefined();
    expect(err?.code).toBe("invalid_value");
  });

  it("accepts all known resource.sensitivity values", () => {
    for (const sensitivity of ["public", "internal", "confidential", "restricted"] as const) {
      const ctx = buildActionContext({
        actor: { id: "user:alice" },
        environment: "production",
        resource: { sensitivity },
      });
      const result = validateActionContext(ctx);
      const err = result.errors.find((e) => e.field === "resource.sensitivity");
      expect(err).toBeUndefined();
    }
  });

  it("errors when a requiredFields path is missing", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
    });
    const result = validateActionContext(ctx, {
      requiredFields: ["resource.id", "actor.roles"],
    });
    expect(result.valid).toBe(false);
    const resourceErr = result.errors.find((e) => e.field === "resource.id");
    expect(resourceErr).toBeDefined();
    expect(resourceErr?.code).toBe("required");
    const rolesErr = result.errors.find((e) => e.field === "actor.roles");
    expect(rolesErr).toBeDefined();
  });

  it("does not error on a requiredFields path that is present", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice", roles: ["admin"] },
      environment: "production",
      resource: { type: "service", id: "api-gw" },
    });
    const result = validateActionContext(ctx, {
      requiredFields: ["resource.id", "actor.roles"],
    });
    const resourceErr = result.errors.find((e) => e.field === "resource.id");
    const rolesErr = result.errors.find((e) => e.field === "actor.roles");
    expect(resourceErr).toBeUndefined();
    expect(rolesErr).toBeUndefined();
  });

  it("skips cross-field checks when skipCrossFieldChecks is true", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
      action_meta: { estimated_amount: 999 }, // no currency
    });
    const result = validateActionContext(ctx, { skipCrossFieldChecks: true });
    const err = result.errors.find((e) => e.field === "action_meta.currency");
    expect(err).toBeUndefined();
  });
});

// ── redactContext ──────────────────────────────────────────────────────────

describe("redactContext", () => {
  it("removes sensitive fields matching DEFAULT_REDACTION_RULES (password)", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
      extra: { password: "s3cr3t" },
    });
    const safe = redactContext(ctx);
    expect(safe).not.toHaveProperty("password");
  });

  it("removes api_key fields", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
      extra: { api_key: "key-abc-123" },
    });
    const safe = redactContext(ctx);
    expect(safe).not.toHaveProperty("api_key");
  });

  it("masks email fields with [REDACTED] sentinel", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice", email: "alice@example.com" },
      environment: "production",
    });
    const safe = redactContext(ctx);
    expect((safe.actor as { email?: string })?.email).toBe("[REDACTED]");
  });

  it("masks token fields with [REDACTED] sentinel", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice", session_id: "sess_abc" },
      environment: "production",
      extra: { auth_token: "tok_xyz" },
    });
    const safe = redactContext(ctx);
    expect(safe.auth_token).toBe("[REDACTED]");
  });

  it("masks ip field on actor", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice", ip: "192.168.1.1" },
      environment: "production",
    });
    const safe = redactContext(ctx);
    expect((safe.actor as { ip?: string })?.ip).toBe("[REDACTED]");
  });

  it("does not mutate the original context", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice", email: "alice@example.com" },
      environment: "production",
    });
    redactContext(ctx);
    expect(ctx.actor?.email).toBe("alice@example.com");
  });

  it("applies custom rules (hash mode)", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
      extra: { internal_id: "obj-999" },
    });
    const safe = redactContext(ctx, [{ field: /internal_id/, mode: "hash" }]);
    expect(safe.internal_id).toBe("[HASHED]");
  });

  it("applies custom rules (remove mode)", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
      extra: { secret_code: "abc" },
    });
    const safe = redactContext(ctx, [{ field: "secret_code", mode: "remove" }]);
    expect(safe).not.toHaveProperty("secret_code");
  });

  it("leaves non-sensitive fields intact", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice", type: "human", roles: ["admin"] },
      environment: { name: "production", region: "us-east-1" },
      resource: { type: "service", id: "api-gw" },
    });
    const safe = redactContext(ctx);
    expect((safe.actor as { id: string }).id).toBe("user:alice");
    expect((safe.actor as { roles?: string[] }).roles).toEqual(["admin"]);
    expect((safe.resource as { id?: string })?.id).toBe("api-gw");
    expect((safe.environment as { region?: string })?.region).toBe("us-east-1");
  });

  it("recurses into array elements that are objects", () => {
    const ctx: import("../src/actionContext.js").ActionContext = {
      actor: { id: "user:alice" },
      environment: { name: "production" },
      contacts: [
        { name: "Bob", email: "bob@example.com" },
        { name: "Carol", email: "carol@example.com" },
      ],
    };
    const safe = redactContext(ctx, DEFAULT_REDACTION_RULES);
    const contacts = safe.contacts as Array<{ name: string; email?: string }>;
    expect(contacts[0]!.name).toBe("Bob");
    expect(contacts[0]!.email).toBe("[REDACTED]");
    expect(contacts[1]!.email).toBe("[REDACTED]");
  });

  it("leaves primitive array elements intact", () => {
    const ctx: import("../src/actionContext.js").ActionContext = {
      actor: { id: "user:alice" },
      environment: { name: "production" },
      tags: ["deploy", "prod"],
    };
    const safe = redactContext(ctx, DEFAULT_REDACTION_RULES);
    expect(safe.tags).toEqual(["deploy", "prod"]);
  });

  it("handles deeply nested sensitive fields", () => {
    const ctx: import("../src/actionContext.js").ActionContext = {
      actor: { id: "user:alice" },
      environment: { name: "production" },
      metadata: {
        billing: {
          credit_card: "4111-1111-1111-1111",
        },
      },
    };
    const safe = redactContext(ctx, DEFAULT_REDACTION_RULES);
    const billing = (safe.metadata as { billing: Record<string, unknown> }).billing;
    expect(billing.credit_card).toBeUndefined();
  });

  it("uses DEFAULT_REDACTION_RULES when no rules arg is passed", () => {
    const ctx: import("../src/actionContext.js").ActionContext = {
      actor: { id: "user:alice" },
      environment: { name: "production" },
      password: "hunter2",
    };
    const safe = redactContext(ctx);
    expect(safe).not.toHaveProperty("password");
  });
});

// ── flattenActionContext ──────────────────────────────────────────────────

describe("flattenActionContext", () => {
  it("sets environment_name as a flat string", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: { name: "production", region: "us-east-1" },
    });
    const flat = flattenActionContext(ctx);
    expect(flat.environment_name).toBe("production");
    expect(typeof flat.environment_name).toBe("string");
  });

  it("preserves the nested environment object alongside the flat shorthand", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: { name: "staging", region: "eu-west-1" },
    });
    const flat = flattenActionContext(ctx);
    expect(flat.environment).toEqual({ name: "staging", region: "eu-west-1" });
    expect(flat.environment_name).toBe("staging");
  });

  it("copies all top-level fields from the context", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
      resource: { type: "service", id: "checkout" },
      extra: { custom: true },
    });
    const flat = flattenActionContext(ctx);
    expect(flat.actor).toEqual({ id: "user:alice" });
    expect(flat.resource).toEqual({ type: "service", id: "checkout" });
    expect(flat.custom).toBe(true);
  });

  it("copies resource_type and resource_id shorthands", () => {
    const ctx = buildActionContext({
      actor: { id: "user:alice" },
      environment: "production",
      resource: { type: "payment", id: "pay-001" },
    });
    const flat = flattenActionContext(ctx);
    expect(flat.resource_type).toBe("payment");
    expect(flat.resource_id).toBe("pay-001");
  });

  it("derives environment_name from environment_name shorthand when no env object", () => {
    const ctx: import("../src/actionContext.js").ActionContext = {
      actor: { id: "user:alice" },
      environment_name: "test",
    };
    const flat = flattenActionContext(ctx);
    expect(flat.environment_name).toBe("test");
  });

  it("does not set environment_name when no environment info is present", () => {
    const ctx: import("../src/actionContext.js").ActionContext = {
      actor: { id: "user:alice" },
    };
    const flat = flattenActionContext(ctx);
    expect(flat.environment_name).toBeUndefined();
  });
});
