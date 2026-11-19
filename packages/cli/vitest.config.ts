import { configDefaults, defineConfig } from "vitest/config";

/**
 * Unit tests run in `test` (tier 1, required in CI). Tests that boot a process
 * or a socket live in `__tests__/integration/` and run in `test:integration`.
 */
export default defineConfig({
  test: {
    setupFiles: ["./__tests__/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["__tests__/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "__tests__/integration/**"],
        },
      },
      {
        extends: true,
        test: { name: "integration", include: ["__tests__/integration/**/*.test.ts"] },
      },
    ],
  },
});
