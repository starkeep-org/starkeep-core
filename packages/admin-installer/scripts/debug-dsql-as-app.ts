/**
 * Connect to DSQL as a specific app's IAM identity — same path the
 * cloud-data-server Lambda uses for /apps/<appId>/sync/pull. Useful for
 * reproducing the Lambda's connection failures outside the Lambda, which is
 * what surfaced the missing `AWS IAM GRANT` bug in dsql-ddl.ts.
 *
 * Connection chain:
 *   admin/manager → starkeep-app-cloud-data-server-role (broker)
 *                 → starkeep-app-<appId>-role
 *                 → DsqlSigner.getDbConnectAuthToken()
 *                 → connect as PG user starkeep_app_<appId>
 *
 * On success, prints current_user. On failure, prints code + message + hint
 * — DSQL hints distinguish IAM-action mismatches, IAM-policy denials, and
 * missing IAM-to-PG mappings (the silent 28000 with no hint).
 *
 * AWS credentials are taken from:
 *   1. ~/.starkeep/cloud-credentials.json (admin-web's cached Cognito creds), OR
 *   2. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN env vars
 *
 * Run via:
 *   pnpm -F @starkeep/admin-installer debug:dsql-as-app <appId>
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
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
    // The cached file stores `expiration` as an ISO string; the AWS SDK calls
    // `.getTime()` on whatever it finds there, so drop it. AWS itself still
    // enforces expiry server-side.
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

async function assume(arn: string, creds: Creds, sessionName: string, region: string): Promise<Creds> {
  const sts = new STSClient({ region, credentials: creds });
  const r = await sts.send(
    new AssumeRoleCommand({ RoleArn: arn, RoleSessionName: sessionName, DurationSeconds: 900 }),
  );
  const c = r.Credentials!;
  return { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! };
}

async function main(): Promise<void> {
  const appId = process.argv[2];
  if (!appId) {
    console.error("usage: debug-dsql-as-app <appId>");
    process.exit(2);
  }

  const cfg = loadStarkeepConfig();
  const region = cfg.region ?? "us-east-2";
  const base = loadBaseCreds();
  const pgUser = `${cfg.stackPrefix}_app_${appId}`.toLowerCase().replace(/-/g, "_");
  const tag = `dbg-${process.pid}`;

  const mgr = await assume(cfg.managerRoleArn, base, `${tag}-mgr`, region);
  const cds = await assume(
    `arn:aws:iam::${cfg.accountId}:role/${cfg.stackPrefix}-app-cloud-data-server-role`,
    mgr,
    `${tag}-cds`,
    region,
  );
  const app = await assume(
    `arn:aws:iam::${cfg.accountId}:role/${cfg.stackPrefix}-app-${appId}-role`,
    cds,
    `${tag}-app`,
    region,
  );

  const signer = new DsqlSigner({ hostname: cfg.auroraEndpoint, region, credentials: app });
  const token = await signer.getDbConnectAuthToken();
  const client = new pg.Client({
    host: cfg.auroraEndpoint,
    port: 5432,
    database: "postgres",
    user: pgUser,
    password: token,
    ssl: { rejectUnauthorized: true },
  });
  try {
    await client.connect();
    const r = await client.query("SELECT current_user, session_user, version()");
    console.log("OK:", r.rows[0]);
    const customSql = process.env.SQL;
    if (customSql) {
      const r2 = await client.query(customSql);
      console.log(`ROWS (${r2.rows.length}):`);
      for (const row of r2.rows) console.log(row);
    }
    await client.end();
  } catch (err) {
    const e = err as { code?: string; message?: string; hint?: string };
    console.error(`FAIL connecting as user=${pgUser}`);
    console.error(`  code:    ${e.code ?? "(none)"}`);
    console.error(`  message: ${e.message ?? "(none)"}`);
    console.error(`  hint:    ${e.hint ?? "(none — typically means missing AWS IAM GRANT in DSQL)"}`);
    process.exit(1);
  }
}

main();
