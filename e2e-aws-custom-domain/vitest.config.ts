import { defineConfig } from "vitest/config";

/**
 * The live custom-domain suite: one serial run against a real AWS account and
 * a real DNS zone. Each attach, change and removal waits on a CloudFront
 * deployment and, for a new name, on ACM validation, so steps run for many
 * minutes.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    // Steps are cumulative: a failed attach makes every later step noise.
    bail: 1,
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 60 * 60 * 1000,
    // Without STARKEEP_AWS_TESTS=1 and a zone, the suite reports skipped.
    passWithNoTests: true,
  },
});
