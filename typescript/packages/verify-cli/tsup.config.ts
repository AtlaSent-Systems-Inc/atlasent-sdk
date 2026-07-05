import { defineConfig } from "tsup";

export default defineConfig([
  // Library: ESM + CJS + types
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
    treeshake: true,
  },
  // CLI: ESM only, shebang prepended
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: false,
    clean: false,
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
