import { defineConfig } from "vitest/config";

/**
 * Every test here boots at least one real `tsx server.ts` child process via
 * @starkeep/testkit, so the wall-clock cost of a test is dominated by process
 * spawn + first-boot work, not by the assertions.
 *
 * The timeouts must therefore sit ABOVE the harness's own budgets — the
 * harness waits up to 30s for /health and `eventually()` polls for 15s. With
 * vitest's 5s default, vitest cut the test short first, so a machine merely
 * under load (a full `turbo run test` spawns every package's suite at once)
 * produced a bare "Test timed out in 5000ms" instead of the harness's error
 * with the child's captured output. Sized so the harness always loses the race
 * and reports the real reason.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    testTimeout: 30_000,
    // beforeAll hooks boot servers (some files boot two plus a fake cloud), and
    // teardown allows 5s per child before escalating to SIGKILL.
    hookTimeout: 60_000,
  },
});
