/**
 * Inspect the DSQL state a schema change touches, as the admin PG role.
 *
 * Read-only. Answers the questions `docs/schema-change-runbook.md` asks you to
 * verify, which `debug-dsql-inspect.ts` does not cover:
 *
 *   - which app schemas exist, and what tables each holds
 *   - the **physical column type** of every column, which is the thing a
 *     declared-type change is trying to move and the thing `IF NOT EXISTS`
 *     silently refuses to move
 *   - whether each `app_syncable_namespaces` row carries `columns`. An untyped
 *     row makes `DsqlAppSyncableNamespaceStore.load()` throw, and because it
 *     loads *every* row, one stale app 500s all of them
 *   - the install-step ledger, which is what decides whether a redeploy runs
 *     `run_dsql_ddl` at all
 *   - row counts per table, for comparing against local after a refill
 *
 * Timestamps are read as `::text`. Both `pg` and PGlite parse a naive
 * `timestamp` with `new Date(...)`, which reinterprets it in the *process*
 * zone — so a verification script that does not do this reports an offset that
 * is not in the database.
 *
 * Credentials, and the temp-policy bootstrap, follow `debug-dsql-inspect.ts`.
 *
 * Run via:
 *   pnpm -F @starkeep/admin-installer tsx scripts/debug-dsql-app-schema.ts [--app <appId>]
 */

import "@starkeep/app-client/load-env";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  IAMClient,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";

interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface StarkeepConfig {
  accountId: string;
  stackPrefix: string;
  managerRoleArn: string;
  auroraEndpoint: string;
  region?: string;
}

function loadStarkeepConfig(): StarkeepConfig {
  const path = join(process.env.STARKEEP_DIR ?? join(homedir(), ".starkeep"), "config.json");
  return JSON.parse(readFileSync(path, "utf8")) as StarkeepConfig;
}

function loadBaseCreds(): Creds {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }
  const cached = join(homedir(), ".starkeep", "cloud-credentials.json");
  if (existsSync(cached)) {
    const raw = JSON.parse(readFileSync(cached, "utf8")) as Creds & { expiration?: string };
    return {
      accessKeyId: raw.accessKeyId,
      secretAccessKey: raw.secretAccessKey,
      sessionToken: raw.sessionToken,
    };
  }
  throw new Error(
    "No AWS credentials: set AWS_* env vars or sign in via admin-web (which writes ~/.starkeep/cloud-credentials.json).",
  );
}

async function assume(
  arn: string,
  creds: Creds,
  sessionName: string,
  region: string,
): Promise<Creds> {
  const sts = new STSClient({ region, credentials: creds });
  const r = await sts.send(
    new AssumeRoleCommand({ RoleArn: arn, RoleSessionName: sessionName, DurationSeconds: 900 }),
  );
  const c = r.Credentials!;
  return {
    accessKeyId: c.AccessKeyId!,
    secretAccessKey: c.SecretAccessKey!,
    sessionToken: c.SessionToken!,
  };
}

async function connectAsAdminWithRetry(
  hostname: string,
  region: string,
  creds: Creds,
): Promise<pg.Client> {
  let lastErr: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      const signer = new DsqlSigner({ hostname, region, credentials: creds });
      const token = await signer.getDbConnectAdminAuthToken();
      const client = new pg.Client({
        host: hostname,
        port: 5432,
        database: "postgres",
        user: "admin",
        password: token,
        ssl: { rejectUnauthorized: true },
      });
      await client.connect();
      return client;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

async function report(client: pg.Client, only: string | undefined): Promise<void> {
  const schemas = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
      WHERE nspname LIKE 'app\\_%' ORDER BY nspname`,
  );

  console.log("\n=== namespace registry (typed columns are required) ===");
  const ns = await client.query<{ app_id: string; tables_json: string }>(
    `SELECT app_id, tables_json FROM shared.app_syncable_namespaces ORDER BY app_id`,
  );
  for (const row of ns.rows) {
    if (only && row.app_id !== only) continue;
    const tables = JSON.parse(row.tables_json) as Array<{ name: string; columns?: unknown[] }>;
    const untyped = tables.filter((t) => !t.columns).map((t) => t.name);
    console.log(
      `  ${row.app_id.padEnd(18)} ${tables.length} tables` +
        (untyped.length > 0
          ? `  UNTYPED: ${untyped.join(", ")}  <-- 500s EVERY app, not just this one`
          : "  all typed"),
    );
  }

  console.log("\n=== install-step ledger (decides whether a redeploy runs the DDL) ===");
  const steps = await client.query<{ app_id: string; step: string; status: string; updated_at: string }>(
    `SELECT app_id, step, status, updated_at::text AS updated_at
       FROM shared.app_install_steps
      WHERE step IN ('run_dsql_ddl', 'attach_temp_install_ddl_policy')
      ORDER BY app_id, step`,
  );
  for (const r of steps.rows) {
    if (only && r.app_id !== only) continue;
    console.log(`  ${r.app_id.padEnd(18)} ${r.step.padEnd(34)} ${r.status.padEnd(8)} ${r.updated_at}`);
  }

  for (const { nspname } of schemas.rows) {
    if (only && nspname !== `app_${only.replace(/-/g, "_")}`) continue;
    console.log(`\n=== ${nspname} ===`);
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 ORDER BY table_name`,
      [nspname],
    );
    if (tables.rows.length === 0) {
      console.log("  (no tables — the schema exists but the DDL has not run)");
      continue;
    }
    for (const { table_name } of tables.rows) {
      const count = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${nspname}.${table_name}`,
      );
      const cols = await client.query<{ data_type: string; n: number }>(
        `SELECT data_type, count(*)::int AS n FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          GROUP BY data_type ORDER BY data_type`,
        [nspname, table_name],
      );
      const shape = cols.rows.map((c) => `${c.data_type}×${c.n}`).join("  ");
      console.log(
        `  ${table_name.padEnd(26)} rows=${String(count.rows[0].n).padEnd(7)} ${shape}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const appIdx = args.indexOf("--app");
  const only = appIdx >= 0 ? args[appIdx + 1] : undefined;

  const cfg = loadStarkeepConfig();
  const region = cfg.region ?? "us-east-2";
  const base = loadBaseCreds();
  const sessionTag = `schema-${process.pid}`;
  const mgr = await assume(cfg.managerRoleArn, base, `${sessionTag}-mgr`, region);

  const iam = new IAMClient({ region, credentials: mgr });
  const roleName = `${cfg.stackPrefix}-install-ddl-role`;
  const policyName = `temp-install-ddl-schema-${sessionTag}`;
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: policyName,
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: ["dsql:DbConnectAdmin", "dsql:DbConnect"], Resource: "*" },
        ],
      }),
    }),
  );

  let exitCode = 0;
  try {
    // IAM propagation to the DSQL data-plane authorizer is tens of seconds.
    await new Promise((r) => setTimeout(r, 12_000));
    const ddl = await assume(
      `arn:aws:iam::${cfg.accountId}:role/${roleName}`,
      mgr,
      `${sessionTag}-ddl`,
      region,
    );
    const client = await connectAsAdminWithRetry(cfg.auroraEndpoint, region, ddl);
    try {
      await report(client, only);
    } finally {
      await client.end().catch(() => {});
    }
  } catch (err) {
    console.error("FAILED:", err);
    exitCode = 1;
  } finally {
    await iam
      .send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }))
      .catch(() => {});
  }
  process.exit(exitCode);
}

void main();
