/**
 * Cloud install registry read endpoint.
 *
 * POST with the user's STS credentials in the body; returns the list of
 * currently-installed cloud apps from `shared.app_registry`, each with the
 * surfaces installed on top of its data side: the web app and the mobile app.
 * This is the single source of truth for "which apps are installed in this
 * cloud stack" — the orchestrator's register_app step writes to it on install
 * completion, and delete_app_registry removes the row on uninstall.
 *
 * The connection is `openInstallerPool` in `src/lib/installer-dsql.ts`.
 */

import { listCloudApps } from "@starkeep/operator/cloud-registry";
import { openInstallerPool } from "../lib/installer-dsql";

// The row shapes and the comparison with the folder live in
// `@starkeep/operator/cloud-registry`, which the CLI's `list` reads too.
export { behindFolder, registryApp, type RegistryDbRow } from "@starkeep/operator/cloud-registry";

export async function POST(req: Request) {
  const opened = await openInstallerPool(req);
  if (opened instanceof Response) return opened;
  const { pool } = opened;

  try {
    const apps = await listCloudApps(pool);
    return Response.json({ apps: apps.map(({ folder: _folder, ...app }) => app) });
  } catch (err) {
    return Response.json(
      { error: `DSQL query failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  } finally {
    await pool.end().catch(() => {});
  }
}
