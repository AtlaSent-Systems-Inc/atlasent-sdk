import { defineConfig } from "tsup";

// Two configs so the CLI gets a shebang while the library does not.
// tsup accepts an array of configs and runs them in series.
export default defineConfig([
  {
    name: "lib",
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    target: "node20",
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    minify: false,
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  {
    name: "cli",
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node20",
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    minify: false,
    banner: { js: "#!/usr/bin/env node" },
    outExtension() {
      return { js: ".js" };
    },
  },
]);
