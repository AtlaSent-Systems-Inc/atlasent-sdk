/**
 * Rate-limit back-off example.
 *
 * Shows how to use the `rateLimit` field returned on every authed
 * response (new in @atlasent/sdk 1.3.0). Rather than hammering the
 * evaluate endpoint until it 429s, the client preemptively sleeps
 * until the next window when its budget gets tight.
 *
 * Run with:
 *   ATLASENT_API_KEY=ask_live_... npx tsx examples/rate-limit-backoff.ts
 */

import { AtlaSentClient, type RateLimitState } from "@atlasent/sdk";

const apiKey = process.env.ATLASENT_API_KEY;
if (!apiKey) {
  console.error("ATLASENT_API_KEY env var is required");
  process.exit(1);
}

const client = new AtlaSentClient({ apiKey });

/**
 * Evaluate a batch of actions, sleeping until the next rate-limit
 * window when fewer than `minRemaining` tokens are left. When the
 * server doesn't emit X-RateLimit-* headers (older deployments or
 * internal endpoints), `rateLimit` is `null` and we fall through —
 * the client will still get a clean 429 + Retry-After at the edge.
 */
async function evaluateBatch(
  actions: Array<{ agent: string; action: string; context?: Record<string, unknown> }>,
  minRemaining = 5,
): Promise<void> {
  for (const [i, req] of actions.entries()) {
    const result = await client.evaluate(req);
    console.log(
      `[${i + 1}/${actions.length}] ${req.action} → ${result.decision} (permit=${result.permitId})`,
    );

    if (shouldBackOff(result.rateLimit, minRemaining)) {
      const waitMs = Math.max(
        0,
        result.rateLimit!.resetAt.getTime() - Date.now(),
      );
      console.log(
        `  …rate-limit low (${result.rateLimit!.remaining} / ${result.rateLimit!.limit}); ` +
          `sleeping ${Math.round(waitMs / 1000)}s until reset`,
      );
      await sleep(waitMs);
    }
  }
}

function shouldBackOff(
  rl: RateLimitState | null,
  minRemaining: number,
): rl is RateLimitState {
  return rl !== null && rl.remaining < minRemaining;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await evaluateBatch([
  { agent: "ci-bot", action: "deploy_production", context: { commit: "abc123" } },
  { agent: "ci-bot", action: "deploy_staging", context: { commit: "abc123" } },
  { agent: "ci-bot", action: "run_integration_tests", context: {} },
]);
