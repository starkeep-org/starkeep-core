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

import { compiler, openInstallerPool } from "../lib/installer-dsql";

export async function POST(req: Request) {
  const opened = await openInstallerPool(req);
  if (opened instanceof Response) return opened;
  const { pool } = opened;

  try {
    const listQuery = compiler
      .selectFrom("shared.app_registry")
      .select(["app_id", "version", "name", "installed_at", "updated_at", "web_app", "mobile_app"])
      .orderBy("installed_at", "asc")
      .compile();
    const result = await pool.query<{
      app_id: string;
      version: string;
      name: string | null;
      installed_at: Date;
      updated_at: Date;
      web_app: boolean | null;
      mobile_app: boolean | null;
    }>(listQuery.sql, [...listQuery.parameters]);
    return Response.json({
      apps: result.rows.map((r) => ({
        appId: r.app_id,
        version: r.version,
        name: r.name,
        installedAt: r.installed_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        webApp: r.web_app === true,
        mobileApp: r.mobile_app === true,
      })),
    });
  } catch (err) {
    return Response.json(
      { error: `DSQL query failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  } finally {
    await pool.end().catch(() => {});
  }
}
