/**
 * Server-only helper to connect to the cloud DSQL cluster as the
 * `${stackPrefix}_installer` Postgres role, using operator STS credentials.
 *
 * Mirrors the inline connection in `app/api/apps/cloud/list/route.ts` (same
 * IAM-to-PG mapping: the admin-app session creds map to the installer role set
 * up by initializeSharedSchema). Deliberately imports only `pg` / dsql-signer /
 * config — NOT `@starkeep/admin-installer`, which transitively pulls Pulumi and
 * OOMs the dev bundle (see that route's note and next.config.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import pg from "pg";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { DsqlSigner } from "@aws-sdk/dsql-signer";

/** Compile-only Kysely (DummyDriver never executes); compiled `$1` SQL runs
 * through the pg pool. Shared across requests — it holds no connection. */
export const dsqlCompiler = new Kysely<Record<string, Record<string, unknown>>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

export interface OperatorCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** A failure that maps to an HTTP response (config missing, creds missing,
 * token signing failed). Carries the status the route should return. */
export class DsqlAdminError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DsqlAdminError";
    this.status = status;
  }
}

interface StarkeepConfig {
  stackPrefix?: string;
  userPoolId?: string;
  auroraEndpoint?: string;
}

function regionFromUserPoolId(userPoolId: string): string | null {
  return userPoolId.split("_")[0] || null;
}

function installerPgUser(stackPrefix: string): string {
  return `${stackPrefix}_installer`.toLowerCase().replace(/-/g, "_");
}

/**
 * Open a single-connection pg pool authenticated as the installer role. The
 * caller MUST `await pool.end()` when done. Throws {@link DsqlAdminError} on any
 * config/credential/signing problem.
 */
export async function connectInstallerDsql(creds: Partial<OperatorCreds>): Promise<pg.Pool> {
  const configPath = join(starkeepDir(), "config.json");
  if (!existsSync(configPath)) {
    throw new DsqlAdminError("Cloud is not configured; finish cloud setup first", 400);
  }
  let config: StarkeepConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as StarkeepConfig;
  } catch {
    throw new DsqlAdminError("config.json is not valid JSON", 500);
  }

  const stackPrefix = config.stackPrefix;
  const hostname = config.auroraEndpoint;
  const region = config.userPoolId ? regionFromUserPoolId(config.userPoolId) : null;
  if (!stackPrefix || !hostname || !region) {
    throw new DsqlAdminError(
      "config.json is missing required fields (stackPrefix, userPoolId, auroraEndpoint); finish cloud setup first",
      400,
    );
  }

  if (!creds.accessKeyId || !creds.secretAccessKey || !creds.sessionToken) {
    throw new DsqlAdminError("accessKeyId, secretAccessKey, sessionToken required", 400);
  }

  const signer = new DsqlSigner({
    hostname,
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
  let token: string;
  try {
    token = await signer.getDbConnectAuthToken();
  } catch (err) {
    throw new DsqlAdminError(
      `Failed to sign DSQL token: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }

  return new pg.Pool({
    host: hostname,
    port: 5432,
    database: "postgres",
    user: installerPgUser(stackPrefix),
    password: token,
    ssl: { rejectUnauthorized: true },
    max: 1,
  });
}
