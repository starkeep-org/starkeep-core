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

import { folderCommit, type FolderCommit } from "@starkeep/admin-installer/app-discovery";
import { appFolders, sameManifest } from "../lib/app-scan";
import type { ManifestSummary } from "../lib/app-types";
import { compiler, openInstallerPool } from "../lib/installer-dsql";

/** One registry row as the database returns it. */
export interface RegistryDbRow {
  app_id: string;
  version: string;
  name: string | null;
  installed_at: Date;
  updated_at: Date;
  web_app: boolean | null;
  mobile_app: boolean | null;
  manifest: string | null;
  web_source_commit: string | null;
}

/**
 * One registry row as the dashboard reads it.
 *
 * `manifest` is the manifest the last install deployed, which the installer
 * records in `registerApp`. The dashboard compares it with the folder's
 * manifest to decide whether a redeploy needs the person's approval again. A
 * row written before the column existed, or one whose text does not parse,
 * carries null, and the dashboard then asks.
 */
export function registryApp(r: RegistryDbRow) {
  return {
    appId: r.app_id,
    version: r.version,
    name: r.name,
    installedAt: r.installed_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    webApp: r.web_app === true,
    mobileApp: r.mobile_app === true,
    manifest: parseManifest(r.manifest),
  };
}

/** An app's folder now: its valid manifest and its git commit. */
export interface FolderNow {
  manifest: Record<string, unknown>;
  commit: FolderCommit | null;
}

/**
 * Whether the cloud install runs something other than what the app's folder
 * holds now.
 *
 * - `behind`: the deployed manifest differs from the folder's. A row without
 *   a recorded manifest counts as behind, because a redeploy records one.
 * - `codeBehind`: the web app deployed from another commit than the folder's
 *   last one, or the folder holds uncommitted changes. A web app without a
 *   recorded commit counts as behind, because a redeploy records one. False
 *   without a web app, whose code the cloud never runs.
 *
 * Each is null when Admin cannot tell: no folder holds a valid manifest for
 * the app, or, for the code, the folder is outside git.
 */
export function behindFolder(
  r: Pick<RegistryDbRow, "manifest" | "web_app" | "web_source_commit">,
  folder: FolderNow | undefined,
): { behind: boolean | null; codeBehind: boolean | null } {
  if (!folder) return { behind: null, codeBehind: null };
  const deployed = parseManifest(r.manifest);
  const behind = deployed === null || !sameManifest(deployed, folder.manifest);
  const codeBehind =
    r.web_app !== true
      ? false
      : folder.commit === null
        ? null
        : folder.commit.dirty || r.web_source_commit !== folder.commit.commit;
  return { behind, codeBehind };
}

function parseManifest(text: string | null): ManifestSummary | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as ManifestSummary) : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const opened = await openInstallerPool(req);
  if (opened instanceof Response) return opened;
  const { pool } = opened;

  try {
    const listQuery = compiler
      .selectFrom("shared.app_registry")
      .select([
        "app_id",
        "version",
        "name",
        "installed_at",
        "updated_at",
        "web_app",
        "mobile_app",
        "manifest",
        "web_source_commit",
      ])
      .orderBy("installed_at", "asc")
      .compile();
    const result = await pool.query<RegistryDbRow>(listQuery.sql, [...listQuery.parameters]);
    const folders = await appFolders();
    return Response.json({
      apps: result.rows.map((r) => {
        const folder = folders.get(r.app_id);
        const now = folder && {
          manifest: folder.manifest,
          // Only a web app runs the folder's code in the cloud.
          commit: r.web_app === true ? folderCommit(folder.dir) : null,
        };
        return { ...registryApp(r), ...behindFolder(r, now) };
      }),
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
