/**
 * Production deploy gate — end-to-end evaluate → permit → deploy → verify.
 *
 * Mirrors the GitHub Actions gate flow in a standalone Node.js script.
 * Drop this into any CI runner that doesn't use GitHub Actions.
 *
 * Run:
 *   ATLASENT_API_KEY=<key> npx ts-node typescript/examples/deploy-gate.ts
 */

import {
  configure,
  withPermit,
  AuthorizationDeniedError,
  AuthorizationUnavailableError,
} from '@atlasent/sdk';

configure({ apiKey: process.env.ATLASENT_API_KEY! });

const SERVICE    = process.env.SERVICE    ?? 'checkout-api';
const COMMIT     = process.env.COMMIT     ?? 'abc123';
const ACTOR      = process.env.ACTOR      ?? 'agent:ci-bot';
const APPROVER   = process.env.APPROVER   ?? '';

async function main() {
  console.log(`\nAtlaSent deploy gate: ${SERVICE} @ ${COMMIT}`);
  console.log(`Actor: ${ACTOR}`);

  try {
    await withPermit(
      {
        actor:  { id: ACTOR, type: 'agent' },
        action: { id: `deploy-${COMMIT}`, type: 'deployment.production' },
        target: { id: SERVICE, type: 'service', environment: 'production' },
        context: {
          commit:             COMMIT,
          signed_attestation: true,
          ...(APPROVER ? { approvals: [APPROVER] } : {}),
        },
      },
      async ({ result, verification }) => {
        console.log(`✓ authorized`);
        console.log(`  permit:     ${result.permitToken}`);
        console.log(`  audit hash: ${verification.auditHash}`);

        // --- your actual deployment command here ---
        console.log(`  deploying ${SERVICE} @ ${COMMIT} to production ...`);
        await deploy(SERVICE, COMMIT);
        console.log('  deployment complete');
      },
    );
  } catch (err) {
    if (err instanceof AuthorizationDeniedError) {
      console.error(`\n✗ BLOCKED by AtlaSent`);
      console.error(`  decision: ${err.decision}`);
      console.error(`  reason:   ${err.reason}`);
      process.exit(1);
    }
    if (err instanceof AuthorizationUnavailableError) {
      console.error('\n✗ BLOCKED: AtlaSent unreachable (fail-closed)');
      process.exit(1);
    }
    throw err;
  }
}

async function deploy(service: string, commit: string) {
  // Replace with: kubectl, helm, aws-deploy, etc.
  await new Promise(resolve => setTimeout(resolve, 20));
  console.log(`  kubectl rollout restart deployment/${service} --image=${commit}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
