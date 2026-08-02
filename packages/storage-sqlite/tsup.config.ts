import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/node-entry.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: "node",
  /**
   * The whole reason `dist` was unusable.
   *
   * tsup 8 rewrites `node:sqlite` to bare `"sqlite"` by default — a package that
   * does not exist — so `dist/index.js` threw ERR_MODULE_NOT_FOUND on first
   * import. (`removeNodeProtocol` exists for Node versions predating the
   * protocol; tsup has said it flips to `false` in the next major, and this
   * package needs that behaviour now.) Neither `platform` nor `external` has any
   * effect on it, which is what makes it slow to find.
   *
   * That broken build is why `exports.import` pointed at `./src/index.ts`:
   * bypassing dist hid it from the workspace. It also made every *published*
   * copy unusable, because `files` ships only `dist` — the source that export
   * named was never in the tarball. Fixed here rather than worked around again.
   */
  removeNodeProtocol: false,
});
