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
  let dbPromise: Promise<Kysely<Record<string, never>>> | null = null;

  // DSQL DbConnect tokens are valid for 15 minutes. An install run can easily
  // exceed that (Pulumi up alone is multi-minute, and resume-on-failure may
  // span longer). We open the connection lazily on first use, and on a
  // SQLSTATE 28P01 (auth failed — typically expired token), tear down and
  // reopen. Since the orchestrator writes infrequently per step, the simpler
  // path is to make every call self-healing.
  async function open(): Promise<Kysely<Record<string, never>>> {
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

  async function db(): Promise<Kysely<Record<string, never>>> {
    if (!dbPromise) dbPromise = open();
    return dbPromise;
  }

  async function withRetry<T>(fn: (db: Kysely<Record<string, never>>) => Promise<T>): Promise<T> {
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
        await sql`
          INSERT INTO shared.app_install_steps
            (app_id, operation, step, status, error, updated_at)
          VALUES (${appId}, ${operation}, ${step}, ${status}, ${error ?? null}, now())
          ON CONFLICT (app_id, operation, step) DO UPDATE
            SET status = EXCLUDED.status,
                error = EXCLUDED.error,
                updated_at = now()
        `.execute(k);
      });
    },

    async getCompletedSteps(appId, operation) {
      return await withRetry(async (k) => {
        const result = await sql<{ step: string }>`
          SELECT step FROM shared.app_install_steps
          WHERE app_id = ${appId}
            AND operation = ${operation}
            AND status = 'done'
        `.execute(k);
        return new Set(result.rows.map((r) => r.step));
      });
    },

    async registerApp(manifest, appId) {
      await withRetry(async (k) => {
        await sql`
          INSERT INTO shared.app_registry (app_id, version, name)
          VALUES (${appId}, ${manifest.version}, ${manifest.name ?? null})
          ON CONFLICT (app_id) DO UPDATE
            SET version = EXCLUDED.version,
                name = EXCLUDED.name,
                updated_at = now()
        `.execute(k);
      });
    },

    async listInstalledApps() {
      return await withRetry(async (k) => {
        const result = await sql<{
          app_id: string;
          version: string;
          name: string | null;
          installed_at: Date | string;
          updated_at: Date | string;
        }>`
          SELECT app_id, version, name, installed_at, updated_at
          FROM shared.app_registry
          ORDER BY installed_at ASC
        `.execute(k);
        return result.rows.map((r) => ({
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
        await sql`DELETE FROM shared.app_registry WHERE app_id = ${appId}`.execute(k);
        await sql`DELETE FROM shared.app_install_steps WHERE app_id = ${appId}`.execute(k);
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
