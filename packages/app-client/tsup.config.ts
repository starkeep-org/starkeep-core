import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/load-env-auto.ts", "src/auth/index.ts", "src/edge.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: "node",
});
