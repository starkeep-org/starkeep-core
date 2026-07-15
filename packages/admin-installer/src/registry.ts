/**
 * Cloud install registry — durable per-step ledger and app registry in DSQL.
 *
 * Mirrors the local installer's shared_app_install_steps / shared_app_registry
 * (see ./local/registry.ts) in `shared.app_install_steps` and
 * `shared.app_registry` on the DSQL cluster. The orchestrator uses this to
 * skip already-completed steps on retry and to record which apps are installed
 * so admin-web can answer "which cloud apps are installed?" without probing
 * AWS resources.
 *
 * Auth model: registry writes use a DbConnect (non-admin) token authenticated
 * as the `${stackPrefix}_installer` PG role, mapped from the admin-app IAM
 * role (the federated entry point — same identity the human admin used to
 * start the install). The mapping is set up at schema-init time by
 * dsql-schema-init.ts. The orchestrator passes admin-app credentials through
 * to createDsqlRegistry; no manager role-chain is involved here.
 */

import pg from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";

// Row types are validated by the live DSQL schema at runtime; the dynamic
// record shape keeps the query builder usable across the shared.* tables.
type RegistryDb = Record<string, Record<string, unknown>>;
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import type { AppManifest } from "@starkeep/admin-manifest";
import { installerPgUser } from "./dsql-schema-init";
import { isRetryableDsqlConflict, isTransientConnectionError } from "./retry-on-access-denied";

export type Operation = "install" | "uninstall";
export type StepStatus = "pending" | "done" | "failed";

export interface RegistryOptions {
  hostname: string;
  region: string;
  stackPrefix: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

export interface InstalledApp {
  appId: string;
  version: string;
  name: string | null;
  installedAt: string;
  updatedAt: string;
}

export interface Registry {
  recordStep(
    appId: string,
    operation: Operation,
    step: string,
    status: StepStatus,
    error?: string,
  ): Promise<void>;
  getCompletedSteps(appId: string, operation: Operation): Promise<Set<string>>;
  registerApp(manifest: AppManifest, appId: string): Promise<void>;
  deleteAppRegistryEntry(appId: string): Promise<void>;
  listInstalledApps(): Promise<InstalledApp[]>;
  close(): Promise<void>;
}

export function createDsqlRegistry(opts: RegistryOptions): Registry {
  const pgUser = installerPgUser(opts.stackPrefix);
  let dbPromise: Promise<Kysely<RegistryDb>> | null = null;

  // DSQL DbConnect tokens are valid for 15 minutes. An install run can easily
  // exceed that (Pulumi up alone is multi-minute, and resume-on-failure may
  // span longer). We open the connection lazily on first use, and on a
  // SQLSTATE 28P01 (auth failed — typically expired token), tear down and
  // reopen. Since the orchestrator writes infrequently per step, the simpler
  // path is to make every call self-healing.
  async function open(): Promise<Kysely<RegistryDb>> {
    const signer = new DsqlSigner({
      hostname: opts.hostname,
      region: opts.region,
      credentials: opts.credentials,
    });
    const token = await signer.getDbConnectAuthToken();
    const pool = new pg.Pool({
      host: opts.hostname,
      port: 5432,
      database: "postgres",
      user: pgUser,
      password: token,
      ssl: { rejectUnauthorized: true },
      max: 1,
    });
    return new Kysely({ dialect: new PostgresDialect({ pool }) });
  }

  async function db(): Promise<Kysely<RegistryDb>> {
    if (!dbPromise) dbPromise = open();
    return dbPromise;
  }

  async function withRetry<T>(fn: (db: Kysely<RegistryDb>) => Promise<T>): Promise<T> {
    const maxAttempts = 6;
    let delay = 500;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn(await db());
      } catch (err) {
        // 28P01 = invalid_password / 28000 = invalid auth (typical when the DSQL
        // DbConnect token has expired mid-run) — reopen with a fresh token. A
        // dropped socket (transient) also needs a reopen. DSQL OCC conflicts
        // (OC*, "updated by another transaction") are catalog-contention on the
        // *healthy* connection — e.g. a step's CREATE INDEX ASYNC still settling
        // when the next ledger write lands — so retry on the same connection.
        // All registry ops are reads or idempotent upserts, so replay is safe.
        const code = (err as { code?: string } | null)?.code;
        const authExpired = code === "28P01" || code === "28000";
        const socketDropped = isTransientConnectionError(err);
        const occConflict = isRetryableDsqlConflict(err);
        if (attempt >= maxAttempts || !(authExpired || socketDropped || occConflict)) {
          throw err;
        }
        if (authExpired || socketDropped) {
          const stale = dbPromise;
          dbPromise = null;
          if (stale) await stale.then((k) => k.destroy()).catch(() => {});
        }
        if (socketDropped || occConflict) {
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 5_000);
        }
      }
    }
    throw new Error("unreachable: registry withRetry");
  }

  return {
    async recordStep(appId, operation, step, status, error) {
      await withRetry(async (k) => {
        await k
          .insertInto("shared.app_install_steps")
          .values({
            app_id: appId,
            operation,
            step,
            status,
            error: error ?? null,
            updated_at: sql`now()`,
          })
          .onConflict((oc) =>
            oc.columns(["app_id", "operation", "step"]).doUpdateSet((eb) => ({
              status: eb.ref("excluded.status"),
              error: eb.ref("excluded.error"),
              updated_at: sql`now()`,
            })),
          )
          .execute();
      });
    },

    async getCompletedSteps(appId, operation) {
      return await withRetry(async (k) => {
        const rows = await k
          .selectFrom("shared.app_install_steps")
          .select("step")
          .where("app_id", "=", appId)
          .where("operation", "=", operation)
          .where("status", "=", "done")
          .execute();
        return new Set(rows.map((r) => r.step as string));
      });
    },

    async registerApp(manifest, appId) {
      await withRetry(async (k) => {
        await k
          .insertInto("shared.app_registry")
          .values({
            app_id: appId,
            version: manifest.version,
            name: manifest.name ?? null,
          })
          .onConflict((oc) =>
            oc.column("app_id").doUpdateSet((eb) => ({
              version: eb.ref("excluded.version"),
              name: eb.ref("excluded.name"),
              updated_at: sql`now()`,
            })),
          )
          .execute();
      });
    },

    async listInstalledApps() {
      return await withRetry(async (k) => {
        const rows = (await k
          .selectFrom("shared.app_registry")
          .select(["app_id", "version", "name", "installed_at", "updated_at"])
          .orderBy("installed_at", "asc")
          .execute()) as unknown as Array<{
          app_id: string;
          version: string;
          name: string | null;
          installed_at: Date | string;
          updated_at: Date | string;
        }>;
        return rows.map((r) => ({
          appId: r.app_id,
          version: r.version,
          name: r.name,
          installedAt:
            r.installed_at instanceof Date ? r.installed_at.toISOString() : r.installed_at,
          updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
        }));
      });
    },

    async deleteAppRegistryEntry(appId) {
      await withRetry(async (k) => {
        await k.deleteFrom("shared.app_registry").where("app_id", "=", appId).execute();
        await k.deleteFrom("shared.app_install_steps").where("app_id", "=", appId).execute();
      });
    },

    async close() {
      if (!dbPromise) return;
      const k = await dbPromise.catch(() => null);
      dbPromise = null;
      if (k) await k.destroy().catch(() => {});
    },
  };
}
