import { startPlatformStack } from "./src/stack.js";

/**
 * Boot the platform once for the whole run. Specs pick the endpoints up from
 * env (workers inherit it). The returned function is Playwright's global
 * teardown.
 */
export default async function globalSetup() {
  const stack = await startPlatformStack();
  process.env.E2E_LDS_URL = stack.lds.url;
  process.env.E2E_LDS_DIR = stack.lds.starkeepDir;
  process.env.E2E_ADMIN_URL = stack.adminUrl;
  process.env.E2E_DRIVE_URL = stack.driveUrl ?? "";
  process.env.E2E_ADMIN_DATA_DIR = stack.adminDataDir;
  // The port admin-web thinks the drive daemon uses — a reserved free port, not
  // the real 9830. Tests that stand in for that daemon bind this.
  process.env.E2E_DRIVE_DAEMON_PORT = String(stack.daemonPorts.drive);
  return async () => {
    await stack.stop();
  };
}
