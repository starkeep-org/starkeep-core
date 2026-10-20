import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // One resolver for the build and the tests: `vite.config.ts`'s plugins and
  // alias come in wholesale, so `@/` cannot mean one thing to the bundler and
  // another to a test. Collapsing those two configurations into one is most of
  // why Vite was chosen.
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // Node by default: most of this suite is route handlers against plain
    // `Request`/`Response`. The page and component tests opt into jsdom with a
    // `@vitest-environment jsdom` docblock, so a DOM is only built where one is
    // actually needed.
    environment: "node",
    setupFiles: ["./__tests__/jsdom-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 90_000,
    // Unit tests run in `test` (tier 1, required in CI). Tests that boot a
    // process, a socket or a database engine live in `__tests__/integration/`
    // and run in `test:integration`.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
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
