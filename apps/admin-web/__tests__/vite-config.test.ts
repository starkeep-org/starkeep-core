/**
 * The browser target has to be stated in three places, and they have to agree.
 *
 * Vite transforms code three times with three independently configured
 * targets: Oxc on the app's own source, Rolldown on the dependency pre-bundle in
 * development, and Rolldown again on the production build. Under Vite 6's
 * esbuild passes, several dependencies the shell loads — the AWS SDK's browser
 * build, sonner, react-router — used destructuring that esbuild refused to
 * transform down to Vite's default baseline, so a target set in only one place
 * failed in the others.
 *
 * That failure is silent in exactly the wrong direction: setting `build.target`
 * alone left `vite build` green and `pnpm dev` unable to start at all, which no
 * other test in this suite would have noticed. Vite 8 also ignores the old
 * `optimizeDeps.esbuildOptions.target` without complaint, so this test pins the
 * keys Vite 8 actually reads.
 */
import { describe, expect, it } from "vitest";
import config from "../vite.config";

describe("the browser target", () => {
  it("is the same for the source, the dev pre-bundle and the build", () => {
    const c = config as {
      oxc?: { target?: string };
      optimizeDeps?: { rolldownOptions?: { transform?: { target?: string } } };
      build?: { target?: string };
    };
    const targets = [
      c.oxc?.target,
      c.optimizeDeps?.rolldownOptions?.transform?.target,
      c.build?.target,
    ];
    expect(targets.every(Boolean), "every transform pass needs an explicit target").toBe(true);
    expect(new Set(targets).size, `targets disagree: ${targets.join(", ")}`).toBe(1);
  });

  it("puts the build's content-hashed output under the platform's reserved prefix", () => {
    // `_immutable` is what the platform's CloudFront behavior and web adapter
    // name. admin-web never reaches either, and matches it anyway so an app
    // author reading this one does not learn a second convention.
    expect((config as { build?: { assetsDir?: string } }).build?.assetsDir).toBe("_immutable");
  });
});
