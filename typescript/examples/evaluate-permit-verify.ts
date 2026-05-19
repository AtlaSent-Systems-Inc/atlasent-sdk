/**
 * Three patterns for evaluate → permit → verify with the AtlaSent TypeScript SDK.
 *
 * Pattern 1: withPermit — recommended for most integrations
 * Pattern 2: authorize + manual verifyPermit
 * Pattern 3: raw evaluate with all four decision branches
 *
 * Run:
 *   npx ts-node typescript/examples/evaluate-permit-verify.ts
 *
 * Requirements:
 *   ATLASENT_API_KEY=<your key>    (or use mock server below)
 *
 * Mock server (no credentials needed):
 *   npx @atlasent/sdk mock          # terminal 1
 *   ATLASENT_API_URL=http://127.0.0.1:4747 ATLASENT_API_KEY=mock npx ts-node typescript/examples/evaluate-permit-verify.ts
 */

import {
  configure,
  withPermit,
  authorize,
  evaluate,
  AtlaSentClient,
  AuthorizationDeniedError,
  AuthorizationUnavailableError,
  PermitVerificationError,
} from '@atlasent/sdk';

configure({ apiKey: process.env.ATLASENT_API_KEY! });

// ---------------------------------------------------------------------------
// Pattern 1: withPermit
//
// Recommended idiom. Wraps evaluate + verifyPermit around the callback.
// The callback only runs if decision === 'allow' AND the permit is consumed.
// Any other outcome throws before fn is called.
// ---------------------------------------------------------------------------
async function pattern1WithPermit() {
  console.log('\n--- Pattern 1: withPermit ---');

  try {
    await withPermit(
      {
        actor:  { id: 'agent:ci-bot',  type: 'agent' },
        action: { id: 'deploy-001',    type: 'deployment.production' },
        target: { id: 'svc-checkout', type: 'service', environment: 'production' },
        context: {
          commit:               'abc123',
          signed_attestation:   true,
          approvals:            ['alice@example.com'],
        },
      },
      async ({ result, verification }) => {
        console.log(`  permit:     ${result.permitToken}`);
        console.log(`  bundle:     ${result.bundleId}@${result.bundleVersion}`);
        console.log(`  audit hash: ${verification.auditHash}`);
        await performDeployment();
        console.log('  deployment complete');
      },
    );
  } catch (err) {
    if (err instanceof AuthorizationDeniedError) {
      console.error(`  blocked: decision=${err.decision}, reason=${err.reason}`);
    } else if (err instanceof AuthorizationUnavailableError) {
      console.error('  blocked: AtlaSent unavailable (fail-closed)');
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Pattern 2: authorize + manual verifyPermit
//
// Use when you need the permit token between evaluate and execute
// (e.g. to store it, pass it to a downstream service, or log it).
// ---------------------------------------------------------------------------
async function pattern2AuthorizeAndVerify() {
  console.log('\n--- Pattern 2: authorize + manual verifyPermit ---');

  const client = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });

  let result;
  try {
    result = await authorize({
      actor:  { id: 'agent:data-pipeline', type: 'agent' },
      action: { id: 'export-001',          type: 'dataset.export' },
      target: { id: 'dataset:phi',         type: 'dataset', environment: 'production' },
      context: { hipaa_baa_active: true, de_identified: false },
    });
  } catch (err) {
    if (err instanceof AuthorizationDeniedError) {
      console.error(`  blocked: ${err.reason}`);
      return;
    }
    throw err;
  }

  console.log(`  authorized: permit=${result.permitToken}`);
  // --- execute your protected action here ---
  await performExport();

  // Verify after execution to close the audit loop.
  try {
    const proof = await client.verifyPermit({ token: result.permitToken });
    console.log(`  verified: consumed=${proof.consumed}, auditHash=${proof.auditHash}`);
  } catch (err) {
    if (err instanceof PermitVerificationError) {
      console.error('  permit verification failed — flag for review');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pattern 3: raw evaluate with all four decision branches
//
// Use when you need full control: inspect the decision before proceeding,
// branch on hold/escalate, or build custom retry/approval logic.
// ---------------------------------------------------------------------------
async function pattern3RawEvaluate() {
  console.log('\n--- Pattern 3: raw evaluate (all four branches) ---');

  let result;
  try {
    result = await evaluate({
      actor:  { id: 'agent:ops-bot', type: 'agent' },
      action: { id: 'rollback-007', type: 'deployment.rollback' },
      target: { id: 'svc-payments', type: 'service', environment: 'production' },
      context: { incident_id: 'INC-9912', on_call: true },
    });
  } catch (err) {
    if (err instanceof AuthorizationUnavailableError) {
      // Fail-closed: AtlaSent is unreachable — do NOT proceed.
      console.error('  blocked: AtlaSent unavailable');
      return;
    }
    throw err;
  }

  console.log(`  decision:   ${result.decision}`);
  console.log(`  bundle:     ${result.bundleId}@${result.bundleVersion}`);
  if (result.reason) console.log(`  reason:     ${result.reason}`);

  switch (result.decision) {
    case 'allow':
      console.log(`  permit:     ${result.permitToken}`);
      await performRollback();
      // Always verify after executing — closes the audit loop and catches replays.
      const client = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });
      const proof = await client.verifyPermit({ token: result.permitToken! });
      console.log(`  audit hash: ${proof.auditHash}`);
      break;

    case 'deny':
      // Policy said no. Do not proceed.
      console.error(`  blocked: ${result.reason}`);
      break;

    case 'hold':
      // Queued for human review. Do not proceed; poll or wait for webhook.
      console.log(`  on hold: awaiting review (hold_id=${result.holdId})`);
      break;

    case 'escalate':
      // Requires escalation — surface to on-call or approval queue.
      console.log('  escalated: routing to approval queue');
      break;
  }
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------
async function performDeployment() {
  // Replace with your actual deployment logic.
  await new Promise(resolve => setTimeout(resolve, 10));
}

async function performExport() {
  await new Promise(resolve => setTimeout(resolve, 10));
}

async function performRollback() {
  await new Promise(resolve => setTimeout(resolve, 10));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  await pattern1WithPermit();
  await pattern2AuthorizeAndVerify();
  await pattern3RawEvaluate();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
