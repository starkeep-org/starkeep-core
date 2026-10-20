import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    // PGlite boots in `beforeAll` in two-users-routes.test.ts, where the 10s
    // hook default applies rather than testTimeout; CI runners crossed it.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
