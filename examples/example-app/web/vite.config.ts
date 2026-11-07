import { defineConfig } from "vite";

/**
 * The browser half.
 *
 * `STARKEEP_APP_BASE_PATH` is the mount the installer chooses: `/apps/example-app`
 * in the cloud and empty locally. It sets Vite's `base`, so every asset URL the
 * build emits already carries it, and the page reads it back from
 * `import.meta.env.BASE_URL` for the URLs it builds itself.
 */
const basePath = (process.env.STARKEEP_APP_BASE_PATH ?? "").replace(/\/+$/, "");

export default defineConfig({
  base: basePath ? `${basePath}/` : "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // The platform's reserved prefix for content-hashed output, which the
    // cloud caches hard. Everything Vite writes here has a hash in its name.
    assetsDir: "_immutable",
  },
});
