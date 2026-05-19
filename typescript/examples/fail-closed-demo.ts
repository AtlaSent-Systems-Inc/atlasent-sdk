/**
 * Fail-closed safety demonstration.
 *
 * Shows that the SDK throws AuthorizationUnavailableError — not allow —
 * when AtlaSent is unreachable. The protected action never executes.
 *
 * Run against a non-existent endpoint to trigger fail-closed:
 *   ATLASENT_API_URL=http://127.0.0.1:9999 ATLASENT_API_KEY=any \
 *     npx ts-node typescript/examples/fail-closed-demo.ts
 */

import {
  configure,
  withPermit,
  AuthorizationUnavailableError,
} from '@atlasent/sdk';

configure({
  apiKey:  process.env.ATLASENT_API_KEY ?? 'test',
  baseUrl: process.env.ATLASENT_API_URL ?? 'http://127.0.0.1:9999',
});

let actionRan = false;

async function main() {
  console.log('Attempting production deploy against unreachable AtlaSent endpoint ...');

  try {
    await withPermit(
      {
        actor:  { id: 'agent:ci-bot',  type: 'agent' },
        action: { id: 'deploy-999',    type: 'deployment.production' },
        target: { id: 'svc-checkout', type: 'service', environment: 'production' },
        context: { commit: 'deadbeef' },
      },
      async () => {
        actionRan = true;  // This must never execute.
        console.error('FAIL: action ran without authorization — fail-closed violated');
      },
    );
  } catch (err) {
    if (err instanceof AuthorizationUnavailableError) {
      console.log('✓ Fail-closed: AuthorizationUnavailableError thrown, action blocked');
      console.log(`  message: ${err.message}`);
    } else {
      throw err;
    }
  }

  if (actionRan) {
    console.error('FAIL: action ran — fail-closed guarantee violated');
    process.exit(1);
  }

  console.log('✓ Protected action did NOT execute. Fail-closed guarantee holds.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
