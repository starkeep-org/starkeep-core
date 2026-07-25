import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // React 19 components under test use the automatic JSX runtime (same as Next).
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      // Route modules import "server-only", which throws outside a Next.js
      // server build. The routes under test run in plain Node here.
      "server-only": fileURLToPath(new URL("./__tests__/stubs/server-only.ts", import.meta.url)),
      // The app's tsconfig `@/*` path, so components can be imported as they
      // import each other.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // API-route tests run in node; component tests opt into jsdom with a
    // `// @vitest-environment jsdom` docblock.
    environment: "node",
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
