import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/hono.ts"],
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
});
