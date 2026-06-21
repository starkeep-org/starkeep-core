/**
 * Inspect DSQL state as the admin PG role.
 *
 * Dumps everything you need to confirm a cloud install actually landed:
 *   - all PG roles (rolname, rolcanlogin)
 *   - sys.iam_pg_role_mappings (IAM ARN → PG role authorizations)
 *   - schemas
 *   - grants on a specific app role (--app <id>, optional)
 *
 * Bootstrapping: admin connections require dsql:DbConnectAdmin, which only the
 * install-ddl-role holds (and only when temp-install-ddl-<name> is attached).
 * This script briefly attaches that temp policy, runs read-only inspection
 * statements, and detaches on exit. It is safe to run while installs are
 * happening — the temp policy uses a distinct PolicyName per script invocation
 * so it can't clobber an install in progress.
 *
 * AWS credentials are taken from:
 *   1. ~/.starkeep/cloud-credentials.json (admin-web's cached Cognito creds), OR
 *   2. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN env vars
 *
 * Either way the principal must be allowed to assume starkeep-manager-role.
 *
 * Run via:
 *   pnpm -F @starkeep/admin-installer debug:dsql-inspect [--app <appId>]
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const appIdx = args.indexOf("--app");
  const appId = appIdx >= 0 ? args[appIdx + 1] : undefined;

  const cfg = loadStarkeepConfig();
  const region = cfg.region ?? "us-east-2";
  const base = loadBaseCreds();

  const sessionTag = `dbg-${process.pid}`;
  const mgr = await assume(cfg.managerRoleArn, base, `${sessionTag}-mgr`, region);

  const iam = new IAMClient({ region, credentials: mgr });
  const roleName = `${cfg.stackPrefix}-install-ddl-role`;
  const policyName = `temp-install-ddl-debug-${sessionTag}`;
  const policyDoc = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["dsql:DbConnectAdmin", "dsql:DbConnect"],
        Resource: "*",
      },
    ],
  });

  await iam.send(
    new PutRolePolicyCommand({ RoleName: roleName, PolicyName: policyName, PolicyDocument: policyDoc }),
  );

  let exitCode = 0;
  try {
    // IAM propagation to DSQL data-plane authorizer is in the tens of seconds.
    await new Promise((r) => setTimeout(r, 12_000));
    const ddl = await assume(
      `arn:aws:iam::${cfg.accountId}:role/${roleName}`,
      mgr,
      `${sessionTag}-ddl`,
      region,
    );
    const client = await connectAsAdminWithRetry(cfg.auroraEndpoint, region, ddl);
    try {
      console.log("\n=== PG roles ===");
      const roles = await client.query(
        `SELECT rolname, rolcanlogin
           FROM pg_roles
          WHERE rolname NOT LIKE 'pg_%'
          ORDER BY rolname`,
      );
      console.table(roles.rows);

      console.log("\n=== sys.iam_pg_role_mappings (IAM ARN ↔ PG role) ===");
      const mappings = await client.query(
        `SELECT pg_role_name, arn, grantor_pg_role_name
           FROM sys.iam_pg_role_mappings
          ORDER BY pg_role_name`,
      );
      console.table(mappings.rows);

      console.log("\n=== Schemas ===");
      const schemas = await client.query(
        `SELECT schema_name, schema_owner
           FROM information_schema.schemata
          WHERE schema_name = 'shared' OR schema_name LIKE 'app_%'
          ORDER BY schema_name`,
      );
      console.table(schemas.rows);

      if (appId) {
        const pgRole = `${cfg.stackPrefix}_app_${appId}`.toLowerCase().replace(/-/g, "_");
        console.log(`\n=== Grants on ${pgRole} ===`);
        const grants = await client.query(
          `SELECT table_schema, table_name, privilege_type
             FROM information_schema.table_privileges
            WHERE grantee = $1
            ORDER BY table_schema, table_name, privilege_type`,
          [pgRole],
        );
        console.table(grants.rows);

        const arn = `arn:aws:iam::${cfg.accountId}:role/${cfg.stackPrefix}-app-${appId}-role`;
        console.log(`\n=== IAM mapping for ${arn} ===`);
        const m = await client.query(
          `SELECT pg_role_name, arn FROM sys.iam_pg_role_mappings WHERE arn = $1`,
          [arn],
        );
        if (m.rows.length === 0) {
          console.log("(none — app cannot connect via dsql:DbConnect until AWS IAM GRANT is executed)");
        } else {
          console.table(m.rows);
        }
      }
    } finally {
      await client.end();
    }
  } catch (err) {
    console.error("error:", err);
    exitCode = 1;
  } finally {
    await iam
      .send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }))
      .catch((err) => console.warn("failed to detach temp policy:", err));
  }
  process.exit(exitCode);
}

main();
