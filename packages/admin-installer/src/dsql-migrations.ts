/**
 * Versioned shared-schema migrations.
 *
 * Each migration is a .sql file shipped alongside an app's manifest. The
 * manifest's `migrations: [...]` array enumerates the ids belonging to that
 * release. The runner applies any not-yet-applied ids in order, substituting
 * the __INSTALLER_USER__ token before execution and recording each success
 * in shared.schema_migrations.
 *
 * Built-in apps (currently only cloud-data-server) are the only apps that
 * ship migrations — third-party apps cannot mutate shared.* DDL.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { DsqlSigner } from "@aws-sdk/dsql-signer";

export interface MigrationRunnerOptions {
  hostname: string;
  region: string;
  stackPrefix: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

/**
 * PG identifier for the privileged installer user. Matches the convention
 * used elsewhere in dsql-ddl.ts (lowercase, hyphens → underscores).
 */
export function installerPgUser(stackPrefix: string): string {
  return `${stackPrefix}_installer`.toLowerCase().replace(/-/g, "_");
}

async function makeDb(opts: MigrationRunnerOptions): Promise<Kysely<any>> {
  const signer = new DsqlSigner({
    hostname: opts.hostname,
    region: opts.region,
    credentials: opts.credentials,
  });
  const token = await signer.getDbConnectAdminAuthToken();
  const pgPool = new pg.Pool({
    host: opts.hostname,
    port: 5432,
    database: "postgres",
    user: installerPgUser(opts.stackPrefix),
    password: token,
    ssl: { rejectUnauthorized: true },
    max: 1,
  });
  return new Kysely({ dialect: new PostgresDialect({ pool: pgPool }) });
}

/**
 * Reads shared.schema_migrations and returns the set of applied migration ids.
 * Returns an empty Set if the table doesn't exist yet (pre-bootstrap state).
 */
export async function getAppliedMigrations(
  opts: MigrationRunnerOptions,
): Promise<Set<string>> {
  const db = await makeDb(opts);
  try {
    const tableExists = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'shared' AND table_name = 'schema_migrations'
      ) as exists
    `.execute(db);

    if (!tableExists.rows[0]?.exists) return new Set();

    const result = await sql<{ id: string }>`
      SELECT id FROM shared.schema_migrations
    `.execute(db);
    return new Set(result.rows.map((r) => r.id));
  } finally {
    await db.destroy();
  }
}

/**
 * Substitutes runner-provided tokens in a migration's SQL text.
 *
 * Tokens are unquoted identifier substitutions, so values must be safe to drop
 * directly into SQL. The installerPgUser() helper enforces lowercase /
 * underscore-only output, so injection isn't a concern with our inputs — but
 * future tokens MUST be similarly constrained.
 */
function applyTokens(text: string, stackPrefix: string): string {
  const installer = installerPgUser(stackPrefix);
  return text.replace(/__INSTALLER_USER__/g, installer);
}

/**
 * Apply any not-yet-applied migrations from `ids` in order. Each migration's
 * SQL is read from `<migrationsDir>/<id>.sql`, token-substituted, and executed
 * as one statement batch under the installer connection. On success the
 * migration is recorded in shared.schema_migrations.
 *
 * Migration files are expected to be idempotent (CREATE ... IF NOT EXISTS,
 * DO blocks, etc.) so a partial-failure retry on the same id is safe.
 */
export async function runMigrations(
  opts: MigrationRunnerOptions,
  migrationsDir: string,
  ids: string[],
): Promise<{ applied: string[]; skipped: string[] }> {
  const applied: string[] = [];
  const skipped: string[] = [];

  // First connection: figure out what's already applied.
  const alreadyApplied = await getAppliedMigrations(opts);
  const toApply = ids.filter((id) => {
    if (alreadyApplied.has(id)) {
      skipped.push(id);
      return false;
    }
    return true;
  });

  if (toApply.length === 0) return { applied, skipped };

  const db = await makeDb(opts);
  try {
    for (const id of toApply) {
      const path = join(migrationsDir, `${id}.sql`);
      const text = applyTokens(readFileSync(path, "utf8"), opts.stackPrefix);

      // pg can run a multi-statement string when there are no parameter
      // bindings — sql.raw() bypasses Kysely's parameterization.
      await sql.raw(text).execute(db);

      // The migration itself should have created shared.schema_migrations on
      // the first run, so this insert is safe from migration 0001 onward.
      await sql`
        INSERT INTO shared.schema_migrations (id) VALUES (${id})
        ON CONFLICT (id) DO NOTHING
      `.execute(db);

      applied.push(id);
    }
  } finally {
    await db.destroy();
  }

  return { applied, skipped };
}
