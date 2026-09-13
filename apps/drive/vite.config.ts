import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The browser half's build.
 *
 * One config for the bundle and, through `vitest.config.ts`'s re-use of the
 * same resolver, one answer for what `@/` means — which is the reason Vite was
 * chosen over a bundler that would have left the test config and the build
 * config as two separate things to keep in step.
 *
 * There is no server half here. `src/server.ts` runs as TypeScript under `tsx`,
 * the way `apps/local-data-server` and `apps/admin-web` do — see the comment at
 * the top of `src/server.ts`.
 *
 * No Tailwind plugin, unlike admin-web's otherwise identical config: Drive's
 * `src/globals.css` is plain CSS and has no build step of its own.
 */
const BROWSER_TARGET = "es2022";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Stated in all three places esbuild asks for it. Vite runs esbuild on the
  // app's source, on the development dependency pre-bundle and on the
  // production build with three independently configured targets, and a target
  // set in only one of them fails in the others — silently in the direction
  // that leaves `vite build` green and `pnpm dev` unable to start.
  esbuild: { target: BROWSER_TARGET },
  optimizeDeps: { esbuildOptions: { target: BROWSER_TARGET } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: BROWSER_TARGET,
    // The platform's reserved prefix for content-addressed output. Drive never
    // reaches CloudFront, and matches it anyway so an app author reading this
    // one does not learn a second convention.
    assetsDir: "_immutable",
    sourcemap: true,
  },
});
