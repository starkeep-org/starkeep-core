import { resolve } from "node:path";
import { DEFAULT_APPS_DIR, expandHome } from "@starkeep/admin-installer/app-discovery";
import { pinnedSourceState, pinsOf, readRegistry, scanApps } from "../lib/app-scan";
import type { LocalAppEntry, ManifestSummary } from "../lib/app-types";

/**
 * The Dashboard's local app list: installed apps from the local data
 * server's registry, then the scanned apps not installed yet.
 *
 * An installed app's card comes from the registry, with the manifest the
 * user approved and the folder Install pinned, so the card never vanishes or
 * switches source when the scanned folders change. A scanned folder whose id
 * an installed app pins is that app when it is the pinned folder, and a
 * conflict otherwise; the scan reports the conflict under its folder.
 */
export async function GET() {
  // null means "we could not ask" — the data server was unreachable or errored.
  // That is not the same fact as "the registry has no row for this app", and
  // collapsing the two made every card read "Not installed" whenever the data
  // server was down, which is the opposite of the truth for installed apps.
  const registry = await readRegistry();
  const { apps: scanned, problems, dirs } = scanApps({ pinned: pinsOf(registry) });
  const scannedById = new Map(scanned.map((s) => [s.appId, s]));
  const registryIds = new Set((registry ?? []).map((r) => r.appId));

  const apps: LocalAppEntry[] = [];
  for (const row of registry ?? []) {
    const found = scannedById.get(row.appId);
    if (row.sourceDir !== null) {
      const source = pinnedSourceState(row.sourceDir, row.manifest);
      apps.push({
        appId: row.appId,
        manifest: row.manifest as ManifestSummary,
        sourceDir: row.sourceDir,
        status: row.status as LocalAppEntry["status"],
        ...(found ? { configuredDir: found.configuredDir } : {}),
        // `sourceState`, with `sourceError` for an invalid manifest and
        // `folderManifest` for a changed one.
        ...(source as Pick<LocalAppEntry, "sourceState" | "sourceError" | "folderManifest"> | null),
      });
    } else if (found) {
      // Installed before the registry pinned folders: the scan still says
      // where it is, until a reinstall pins it. A built-in app has no folder
      // and no card.
      apps.push({
        appId: row.appId,
        manifest: found.manifest as ManifestSummary,
        sourceDir: found.appDir,
        status: row.status as LocalAppEntry["status"],
        configuredDir: found.configuredDir,
      });
    }
  }

  for (const s of scanned) {
    if (registryIds.has(s.appId)) continue;
    apps.push({
      appId: s.appId,
      manifest: s.manifest as ManifestSummary,
      sourceDir: s.appDir,
      status: registry ? "not_installed" : "unknown",
      configuredDir: s.configuredDir,
      // The example app core ships, from the folder a new config seeds.
      // Matched by folder rather than id, because authors copy the app.
      ...(resolve(expandHome(s.configuredDir)) === DEFAULT_APPS_DIR
        ? { bundledExample: true }
        : {}),
    });
  }

  return Response.json({ apps, problems, dirs, dataServerReachable: registry !== null });
}
