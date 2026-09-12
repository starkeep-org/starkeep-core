import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The browser half's build.
 *
 * One config for the bundle and, through `vitest.config.ts`'s re-use of the
 * same resolver, one answer for what `@/` means — which is the reason Vite was
 * chosen over a bundler that would have left the test config and the build
 * config as two separate things to keep in step.
 *
 * There is no server half here. `src/server.ts` runs as TypeScript under `tsx`,
 * the way `apps/local-data-server` does, because admin-web is only ever run
 * from this checkout on the operator's own machine — see the comment at the top
 * of `src/server.ts`.
 */
const BROWSER_TARGET = "es2022";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Above Vite's default browser baseline, and stated in both places it is
  // asked for. admin-web is a local console the operator opens in whatever
  // browser is on the machine they are already administering, so there is no
  // old-browser audience to lower for — and several dependencies the shell
  // legitimately loads (the AWS SDK's browser build, sonner, react-router) use
  // destructuring esbuild refuses to transform to the lower target at all.
  //
  // `build.target` alone is not enough: dependency pre-bundling in development
  // is a separate esbuild pass with its own target, and leaving it at the
  // default made `--dev` fail to start while `vite build` succeeded.
  esbuild: { target: BROWSER_TARGET },
  optimizeDeps: { esbuildOptions: { target: BROWSER_TARGET } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: BROWSER_TARGET,
    // The platform's reserved prefix for content-addressed output. admin-web
    // never reaches CloudFront, but the prefix is the platform's convention and
    // an app that diverges from it for no reason is the drift `_immutable`
    // exists to end.
    assetsDir: "_immutable",
    sourcemap: true,
  },
  server: {
    // admin-web is operated from the same machine by default, and Vite refuses
    // a dev-server request whose Host it does not recognise. To reach it from
    // another device on your LAN, list that device's view of this host
    // (comma-separated hostnames/IPs) in STARKEEP_ADMIN_DEV_ORIGINS — the
    // repo-root .env is loaded by src/server.ts before this config is read.
    allowedHosts: process.env.STARKEEP_ADMIN_DEV_ORIGINS
      ? process.env.STARKEEP_ADMIN_DEV_ORIGINS.split(",").map((s) => s.trim())
      : undefined,
  },
});
