import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/load-env-auto.ts",
    "src/auth/index.ts",
    "src/edge.ts",
    "src/lambda.ts",
    "src/web.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: "node",
  // Chunk splitting stays on, which is tsup's default for ESM and what every
  // published version has shipped.
  //
  // Turning it off looked attractive while adding the `lambda` and `web`
  // entries — each would emit one self-contained file, easy to reason about
  // inside a Lambda zip. It is the wrong trade twice over. It would duplicate
  // `auth/verify.ts` into both `index.js` and `auth/index.js`, and an app
  // importing from both subpaths (all three do) would then hold two JWKS
  // caches instead of one. And it buys nothing: the only chunk `web` shares is
  // `lambda` itself, so the subpath is already free of `credentials.ts` and the
  // AWS SDK. `__tests__/subpath-deps.test.ts` follows the chunk graph and is
  // what actually holds that property.
});
