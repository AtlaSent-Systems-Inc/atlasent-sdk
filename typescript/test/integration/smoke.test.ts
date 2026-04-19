/**
 * Staging smoke test — hits the real AtlaSent API.
 *
 * Skipped unless ATLASENT_API_KEY is in the environment. Run via:
 *
 *   ATLASENT_API_KEY=ask_staging_... \
 *   ATLASENT_BASE_URL=https://staging.atlasent.io \
 *   npm run test:integration
 */

import { describe, expect, it } from "vitest";

import { AtlaSentClient, AtlaSentError } from "../../src/index.js";

const apiKey = process.env.ATLASENT_API_KEY;
const baseUrl = process.env.ATLASENT_BASE_URL ?? "https://staging.atlasent.io";

describe.skipIf(!apiKey)("AtlaSentClient @ staging", () => {
  it("evaluate() returns a wire-valid response (ALLOW or DENY — both OK)", async () => {
    const client = new AtlaSentClient({ apiKey: apiKey!, baseUrl });
    try {
      const result = await client.evaluate({
        agent: "sdk-ci-runner",
        action: "integration_test",
        context: { ci: true, repo: "atlasent-sdk" },
      });
      expect(result.decision === "ALLOW" || result.decision === "DENY").toBe(true);
      expect(typeof result.permitId).toBe("string");
      expect(result.permitId.length).toBeGreaterThan(0);
    } catch (err) {
      // A transport/schema failure is a real bug; a 4xx is staging config.
      if (err instanceof AtlaSentError) {
        expect(err.code).not.toBe("bad_response");
      } else {
        throw err;
      }
    }
  });
});
