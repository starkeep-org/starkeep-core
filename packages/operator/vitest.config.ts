import { defineConfig } from "vitest/config";

/**
 * Unit tests only. The daemon and run tests that boot processes stay in
 * admin-web's integration suite, which drives this package through its routes.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["__tests__/**/*.test.ts"] },
      },
    ],
  },
});
