import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Route modules import "server-only", which throws outside a Next.js
      // server build. The routes under test run in plain Node here.
      "server-only": fileURLToPath(new URL("./__tests__/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
