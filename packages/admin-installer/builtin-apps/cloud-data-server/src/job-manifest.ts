/**
 * An installed app's scheduled jobs, read from the manifest the installer
 * stored in `shared.app_registry`.
 *
 * Read by hand rather than through `@starkeep/admin-manifest`, which this
 * bundle does not carry, as `delegatedPathsOf` does. The installer stores the
 * validated manifest, so every field below was checked at install. A field
 * that still reads wrong drops the job rather than guessing at it.
 */
import type { DelegationMode } from "@starkeep/protocol-primitives";
import { postgresCompiler, type DatabaseClient } from "@starkeep/storage-aurora-dsql";

/** One job, with what the dispatcher needs from its compute handler. */
export interface JobTemplate {
  name: string;
  /** The compute handler's name, the last part of its function's name. */
  handler: string;
  mode: DelegationMode;
  defaultTime: string | null;
  description: string;
  /** The handler's timeout, which bounds the run's lease. */
  timeoutSeconds: number;
}

/** An installed app's jobs, and its display name. */
export interface JobApp {
  appId: string;
  name: string;
  jobs: JobTemplate[];
}

/** The jobs a stored manifest declares. An unreadable manifest declares none. */
export function jobTemplatesOf(manifestJson: unknown): JobTemplate[] {
  if (typeof manifestJson !== "string") return [];
  try {
    const manifest = JSON.parse(manifestJson) as {
      infraRequirements?: {
        compute?: { enabled?: unknown; handlers?: { name?: unknown; timeoutSeconds?: unknown }[] };
        jobs?: unknown[];
      };
    };
    const compute = manifest.infraRequirements?.compute;
    if (compute?.enabled !== true) return [];
    const timeouts = new Map<string, number>();
    for (const h of compute.handlers ?? []) {
      if (typeof h?.name !== "string") continue;
      timeouts.set(h.name, typeof h.timeoutSeconds === "number" ? h.timeoutSeconds : 30);
    }
    const jobs: JobTemplate[] = [];
    for (const raw of manifest.infraRequirements?.jobs ?? []) {
      if (typeof raw !== "object" || raw === null) continue;
      const j = raw as Record<string, unknown>;
      if (typeof j.name !== "string" || typeof j.handler !== "string") continue;
      if (j.mode !== "read" && j.mode !== "readwrite") continue;
      const timeoutSeconds = timeouts.get(j.handler);
      if (timeoutSeconds === undefined) continue;
      jobs.push({
        name: j.name,
        handler: j.handler,
        mode: j.mode,
        defaultTime: typeof j.defaultTime === "string" ? j.defaultTime : null,
        description: typeof j.description === "string" ? j.description : "",
        timeoutSeconds,
      });
    }
    return jobs;
  } catch {
    return [];
  }
}

type Db = Record<string, Record<string, unknown>>;
const compiler = postgresCompiler as unknown as import("kysely").Kysely<Db>;

/**
 * One installed app's jobs, or null when the app has no cloud web app: its
 * jobs run on its compute handlers, which only a web install deploys.
 */
export async function loadJobApp(client: DatabaseClient, appId: string): Promise<JobApp | null> {
  const compiled = compiler
    .selectFrom("shared.app_registry")
    .select(["app_id", "name", "manifest", "web_app"])
    .where("app_id", "=", appId)
    .compile();
  const result = await client.query(compiled.sql, [...compiled.parameters]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row || row.web_app !== true) return null;
  return {
    appId,
    name: typeof row.name === "string" && row.name ? row.name : appId,
    jobs: jobTemplatesOf(row.manifest),
  };
}

/**
 * The mode a run of `template` gets for an enrollment the user approved in
 * `approved`, or null when the app now asks for more than the user saw. A
 * narrower template runs at the narrower mode.
 */
export function runMode(approved: DelegationMode, template: JobTemplate): DelegationMode | null {
  if (template.mode === "readwrite" && approved === "read") return null;
  return template.mode;
}
