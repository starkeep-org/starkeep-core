import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // One resolver for the build and the tests: `vite.config.ts`'s plugin and
  // alias come in wholesale, so `@/` cannot mean one thing to the bundler and
  // another to a test.
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // Node by default: most of this suite is route handlers against plain
    // `Request`/`Response`. The page test opts into jsdom with a
    // `@vitest-environment jsdom` docblock, so a DOM is only built where one is
    // actually needed.
    environment: "node",
    setupFiles: ["./__tests__/setup.ts"],
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
  },
});
