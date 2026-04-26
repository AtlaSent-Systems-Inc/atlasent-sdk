#!/usr/bin/env -S npx tsx
/**
 * Bin shim — forwards process argv / stdout / stderr / exit code
 * to the programmatic CLI in `src/cli/verify.ts`.
 *
 * Direct invocation (from a checkout):
 *   ./bin/atlasent-v2-verify.mjs --key key.pem bundle.json
 *   npx tsx bin/atlasent-v2-verify.mjs --key key.pem bundle.json
 *
 * After v2 GA flips this package to private:false and adds a build
 * step, the bin script will resolve a compiled `dist/cli/verify.js`
 * and `npx @atlasent/sdk-v2-preview verify ...` will work natively.
 */

import { run } from "../src/cli/verify.ts";

const result = await run(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
