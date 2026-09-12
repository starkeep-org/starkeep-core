import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

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
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
    setupFiles: ["./__tests__/jsdom-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
