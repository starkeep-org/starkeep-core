/**
 * The browser target has to be stated in three places, and they have to agree.
 *
 * Vite runs esbuild three times with three independently configured targets:
 * once on the app's own source, once on the dependency pre-bundle in
 * development, and once on the production build. Several dependencies the shell
 * loads — the AWS SDK's browser build, sonner, react-router — use destructuring
 * that esbuild refuses to transform down to Vite's default baseline, so a
 * target set in only one place fails in the others.
 *
 * That failure is silent in exactly the wrong direction: setting `build.target`
 * alone left `vite build` green and `pnpm dev` unable to start at all, which no
 * other test in this suite would have noticed.
 */
import { describe, expect, it } from "vitest";
import config from "../vite.config";

describe("the browser target", () => {
  it("is the same for the source, the dev pre-bundle and the build", () => {
    const c = config as {
      esbuild?: { target?: string };
      optimizeDeps?: { esbuildOptions?: { target?: string } };
      build?: { target?: string };
    };
    const targets = [
      c.esbuild?.target,
      c.optimizeDeps?.esbuildOptions?.target,
      c.build?.target,
    ];
    expect(targets.every(Boolean), "every esbuild pass needs an explicit target").toBe(true);
    expect(new Set(targets).size, `targets disagree: ${targets.join(", ")}`).toBe(1);
  });

  it("puts the build's content-hashed output under the platform's reserved prefix", () => {
    // `_immutable` is what the platform's CloudFront behavior and web adapter
    // name. admin-web never reaches either, and matches it anyway so an app
    // author reading this one does not learn a second convention.
    expect((config as { build?: { assetsDir?: string } }).build?.assetsDir).toBe("_immutable");
  });
});
