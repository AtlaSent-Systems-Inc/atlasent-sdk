/**
 * One-line execution-time authorization with `atlasent.protect`.
 *
 * `protect` is fail-closed: if the action is allowed, it returns a
 * verified `Permit`. If anything else happens — policy denial, permit
 * revoked, network error, rate limit — it throws, and the action
 * simply cannot execute. This is the category boundary: there is no
 * `{ permitted: false }` branch to forget.
 *
 * Run with:
 *   ATLASENT_API_KEY=ask_live_... npx tsx examples/protect.ts
 */

import atlasent, { AtlaSentDeniedError, AtlaSentError } from "@atlasent/sdk";

async function deploy(commit: string, approver: string): Promise<void> {
  try {
    const permit = await atlasent.protect({
      agent: "deploy-bot",
      action: "deploy_to_production",
      context: { commit, approver },
    });
    console.log(
      `Deploy approved — permitId=${permit.permitId} auditHash=${permit.auditHash}`,
    );
    // runDeploy(commit);
  } catch (err) {
    if (err instanceof AtlaSentDeniedError) {
      // Policy said no (or permit failed verification). Log the
      // evaluationId so auditors can trace the decision.
      console.error(
        `Deploy blocked: ${err.reason ?? err.decision} (evaluationId=${err.evaluationId})`,
      );
      process.exit(1);
    }
    if (err instanceof AtlaSentError) {
      // Transport / auth / server failure. Fail-closed: do not deploy.
      console.error(
        `AtlaSent unavailable (code=${err.code} requestId=${err.requestId ?? "?"}): ${err.message}`,
      );
      process.exit(2);
    }
    throw err;
  }
}

void deploy(
  process.env.GIT_SHA ?? "HEAD",
  process.env.APPROVER ?? process.env.USER ?? "unknown",
);
