/**
 * The cloud's app registry, `shared.app_registry`, as admin-web's cloud
 * column and the CLI's `list` and `update` read it.
 *
 * The connection runs as `<stackPrefix>_installer`, the Postgres role the
 * admin role maps to (`dsql-schema-init.ts` in admin-installer), with the
 * signed-in admin's credentials. This module talks to the cluster directly
 * rather than through admin-installer's registry, because that one pulls in
 * Pulumi, which admin-web's dev server cannot hold.
 */
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { sourceFingerprint } from "@starkeep/admin-installer/app-discovery";
import { withoutFilledPlatformEnv } from "@starkeep/admin-installer/platform-env";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import pg from "pg";
import { appFolders, sameManifest } from "./apps";

/** Compile-only Kysely: the compiled `$1`-style SQL runs through a pg pool. */
export const compiler = new Kysely<Record<string, Record<string, unknown>>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

export function installerPgUser(stackPrefix: string): string {
  return `${stackPrefix}_installer`.toLowerCase().replace(/-/g, "_");
}

export interface InstallerPoolOptions {
  hostname: string;
  region: string;
  stackPrefix: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
}

/** A one-connection pool on the cloud cluster as the installer role. The caller ends it. */
export async function installerPool(options: InstallerPoolOptions): Promise<pg.Pool> {
  const signer = new DsqlSigner({
    hostname: options.hostname,
    region: options.region,
    credentials: options.credentials,
  });
  const token = await signer.getDbConnectAuthToken();
  return new pg.Pool({
    host: options.hostname,
    port: 5432,
    database: "postgres",
    user: installerPgUser(options.stackPrefix),
    password: token,
    ssl: { rejectUnauthorized: true },
    max: 1,
  });
}

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
  web_source_hash: string | null;
  /** Absent on a cluster whose schema predates the source columns. */
  source_commit?: string | null;
  source_dirty?: boolean | null;
}

function parseManifest(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * One registry row as a reader shows it.
 *
 * `manifest` is the manifest the last install deployed, which the installer
 * records in `registerApp`. A reader compares it with the folder's manifest to
 * decide whether a redeploy needs the person's approval again. A row written
 * before the column existed, or one whose text does not parse, carries null.
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
    /** The commit the last install built from, or null when it recorded none. */
    sourceCommit: r.source_commit ?? null,
    /** Whether that folder had uncommitted changes. */
    sourceDirty: r.source_dirty === true,
  };
}

/** An app's folder now: its valid manifest and its code's fingerprint. */
export interface FolderNow {
  manifest: Record<string, unknown>;
  /** The folder's `sourceFingerprint`; null when it cannot be computed. */
  source: string | null;
}

/**
 * Whether the cloud install runs something other than what the app's folder
 * holds now.
 *
 * - `behind`: the deployed manifest differs from the folder's, apart from the
 *   platform variables the install filled in (`platform-env.ts`). A row
 *   without a recorded manifest counts as behind, because a redeploy records
 *   one.
 * - `codeBehind`: the web app deployed code other than what the folder holds
 *   now, committed or not. A web app without a recorded fingerprint counts as
 *   behind, because a redeploy records one. False without a web app, whose
 *   code the cloud never runs.
 *
 * Each is null when no folder holds a valid manifest for the app, or, for the
 * code, when the folder has no fingerprint.
 */
export function behindFolder(
  r: Pick<RegistryDbRow, "manifest" | "web_app" | "web_source_hash">,
  folder: FolderNow | undefined,
): { behind: boolean | null; codeBehind: boolean | null } {
  if (!folder) return { behind: null, codeBehind: null };
  const deployed = parseManifest(r.manifest);
  // The install fills the handlers' platform variables before it records the
  // manifest, so those filled values are not a change.
  const behind =
    deployed === null ||
    !sameManifest(withoutFilledPlatformEnv(deployed, folder.manifest), folder.manifest);
  const codeBehind =
    r.web_app !== true
      ? false
      : folder.source === null
        ? null
        : r.web_source_hash !== folder.source;
  return { behind, codeBehind };
}

export type CloudApp = ReturnType<typeof registryApp> & {
  behind: boolean | null;
  codeBehind: boolean | null;
  /** The folder the comparison used, or null when none holds the app. */
  folder: string | null;
};

/** Every app installed in the cloud, each compared with its folder on this computer. */
export async function listCloudApps(pool: pg.Pool): Promise<CloudApp[]> {
  const query = compiler
    .selectFrom("shared.app_registry")
    // Every column, so a cluster whose schema predates a column still lists.
    .selectAll()
    .orderBy("installed_at", "asc")
    .compile();
  const result = await pool.query<RegistryDbRow>(query.sql, [...query.parameters]);
  const folders = await appFolders();
  return result.rows.map((r) => {
    const folder = folders.get(r.app_id);
    const now = folder && {
      manifest: folder.manifest,
      // Only a web app runs the folder's code in the cloud.
      source: r.web_app === true ? sourceFingerprint(folder.dir) : null,
    };
    return { ...registryApp(r), ...behindFolder(r, now), folder: folder?.dir ?? null };
  });
}
