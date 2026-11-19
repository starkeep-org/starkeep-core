/**
 * The CLI's entry point. `scripts/starkeep.mjs` starts it under tsx, in the
 * folder the person ran the command in, which it passes as `STARKEEP_CWD`.
 *
 * The checkout's `.env` decides STARKEEP_DIR and the ports, the same file the
 * data server and admin-web read. It loads from the checkout's root rather than
 * the person's folder, which may be an app's own workspace, and it loads before
 * anything else: several modules read STARKEEP_DIR when they load.
 */
import { repoRoot } from "@starkeep/operator/repo-root";

process.env.STARKEEP_ENV_DIR ??= repoRoot();
await import("@starkeep/app-client/load-env");
const { main } = await import("./main");

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.env.STARKEEP_CWD ?? process.cwd(),
});
