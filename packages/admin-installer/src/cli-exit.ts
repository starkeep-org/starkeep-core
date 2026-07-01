/**
 * Force a non-zero process exit when a top-level install/uninstall await
 * rejects.
 *
 * WHY THIS EXISTS: our install/uninstall CLIs run an *inline* Pulumi
 * `stack.up()` / `destroy()`. When that inline operation fails, the Pulumi
 * language host (loaded in-process to execute the inline program) leaves the
 * process's rejection handling in a state where a *subsequent* top-level
 * unhandled rejection is swallowed and the process exits **0**. A re-thrown
 * install error therefore looks like success to anything keying off the exit
 * code — the e2e harness's `runInstallCli` and admin-web's `/api/exec` both do.
 *
 * Catching the rejection directly at the awaited call and calling
 * `process.exit(1)` is the only pattern that survives that interference: a
 * passive `process.on("unhandledRejection", …)` guard is stripped by the
 * Pulumi host and never fires. Attach this to the top-level install/uninstall
 * await:
 *
 *     await installX({ … }).catch(exitOnInstallFailure);
 */
export function exitOnInstallFailure(err: unknown): never {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
}
