import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** The workspace root holding both `starkeep-core` and `starkeep-apps`. */
const CHECKOUTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Tier-3 runner: one serial journey against a real AWS account. Individual
 * steps (CloudFormation create, Pulumi up) run for minutes, so the timeouts
 * are sized in tens of minutes, not seconds.
 */
export default defineConfig({
  server: {
    // The rendition step reads Photos' ladder straight out of the sibling
    // starkeep-apps checkout, so the expectation moves with a respec instead of
    // being copied into this repository. Vite refuses to load a file outside
    // its root without this, and the path is computed rather than written down
    // so it survives a checkout living anywhere.
    fs: { allow: [CHECKOUTS_ROOT] },
  },
  test: {
    include: ["src/**/*.test.ts"],
    // The journey is one ordered sequence; never parallelize or isolate it.
    fileParallelism: false,
    // Steps are cumulative; a failed install makes everything after it noise.
    bail: 1,
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 30 * 60 * 1000,
    // STARKEEP_AWS_TESTS unset → every suite self-skips; that's a pass.
    passWithNoTests: true,
  },
});
