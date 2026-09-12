import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Route modules import "server-only", which throws outside a Next.js
      // server build. The routes under test run in plain Node here.
      "server-only": fileURLToPath(new URL("./__tests__/stubs/server-only.ts", import.meta.url)),
      // The same `@/` the app is written against. Component tests import the
      // components as they are, rather than through a second spelling that
      // would stop matching if the alias moved.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Node by default: most of this suite is route handlers against plain
    // `Request`/`Response`. The page and component tests opt into jsdom with a
    // `@vitest-environment jsdom` docblock, so a DOM is only built where one is
    // actually needed.
    environment: "node",
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
    setupFiles: ["./__tests__/jsdom-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
