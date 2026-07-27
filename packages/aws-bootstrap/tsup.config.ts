import { defineConfig } from "tsup";

export default defineConfig({
  // Two entry points, not one: `bedrock-budget-ops` pulls in the Budgets and IAM
  // SDK clients and is server-only, so it must stay reachable WITHOUT importing
  // the package index — admin-web's client-side setup wizard imports the index.
  entry: ["src/index.ts", "src/bedrock-budget-ops.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
});
