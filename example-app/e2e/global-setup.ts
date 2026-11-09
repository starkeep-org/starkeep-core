import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startPlatformStack } from "@starkeep/e2e";

/**
 * Boot a local platform from starkeep-core's source: local-data-server,
 * admin-web and Drive. `scripts/link-core-harness.mjs` linked the harness
 * before this run, from `STARKEEP_CORE_DIR` or the checkout it found.
 *
 * admin-web scans the folder that holds this app, so it finds the app's root
 * manifest the way it would on an operator's computer.
 */
export default async function globalSetup() {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const stack = await startPlatformStack({ appParentDirs: [dirname(appDir)] });
  process.env.E2E_LDS_URL = stack.lds.url;
  process.env.E2E_ADMIN_URL = stack.adminUrl;
  process.env.E2E_DRIVE_URL = stack.driveUrl ?? "";
  return async () => {
    await stack.stop();
  };
}
