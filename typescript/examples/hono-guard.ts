/**
 * Drop-in route protection for a Hono app.
 *
 * `atlaSentGuard` is Hono middleware that calls `atlasent.protect()`
 * before the handler runs. On allow, it stashes the verified Permit
 * on the Hono context; on deny or transport error it throws, and
 * `atlaSentErrorHandler` (installed via `app.onError`) maps those
 * throws to HTTP responses.
 *
 * Run with:
 *   ATLASENT_API_KEY=ask_live_... npx tsx examples/hono-guard.ts
 */

import { Hono } from "hono";

import type { Permit } from "@atlasent/sdk";
import { atlaSentErrorHandler, atlaSentGuard } from "@atlasent/sdk/hono";

// Declare the Permit on Variables so `c.get("atlasent")` is typed.
type AppEnv = { Variables: { atlasent: Permit } };

const app = new Hono<AppEnv>();

// One-line map of all AtlaSent errors to HTTP responses. Denials
// return 403; transport/auth failures return 503. Override denyStatus,
// errorStatus, or the render* hooks if you want different shapes.
app.onError(atlaSentErrorHandler());

app.post(
  "/deploy/:service",
  atlaSentGuard({
    action: (c) => `deploy_${c.req.param("service")}`,
    agent: (c) => c.req.header("x-agent-id") ?? "anonymous",
    context: async (c) => {
      const body = await c.req.json<{ commit: string }>();
      return {
        commit: body.commit,
        approver: c.req.header("x-approver") ?? "unknown",
        environment: "production",
      };
    },
  }),
  (c) => {
    // If we got here, AtlaSent authorized the call end-to-end.
    const permit = c.get("atlasent");
    // runDeploy(c.req.param("service"), ...);
    return c.json({
      ok: true,
      service: c.req.param("service"),
      permitId: permit.permitId,
      auditHash: permit.auditHash,
    });
  },
);

export default app;
