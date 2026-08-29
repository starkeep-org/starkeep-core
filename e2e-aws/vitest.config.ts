import { defineConfig } from "vitest/config";

/**
 * Tier-3 runner: one serial journey against a real AWS account. Individual
 * steps (CloudFormation create, Pulumi up) run for minutes, so the timeouts
 * are sized in tens of minutes, not seconds.
 */
export default defineConfig({
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
