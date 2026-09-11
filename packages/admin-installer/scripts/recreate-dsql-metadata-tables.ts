/**
 * Recreate the ten per-category metadata tables on DSQL, so they gain a column
 * the `IF NOT EXISTS` DDL can never add to a table that already exists.
 *
 * Step 2 of `investigation-photos-exif-extraction-2026-09-10.md`, which adds
 * `exif_present` to `IMAGE_METADATA_COLUMNS`. `ALTER TABLE ALTER COLUMN` is the
 * move DSQL refuses (0A000), so a declared-column change to these tables means
 * dropping them — see `docs/schema-change-runbook.md`.
 *
 * These tables are the case that runbook explicitly does **not** cover: they
 * live only in `shared.*` and no sync refills them from local. What makes the
 * drop safe here is that they hold zero rows, and this refuses to run if that
 * is not still true rather than trusting the measurement that said so.
 *
 * Recreation runs `initializeSharedSchema` rather than a copy of its DDL loop,
 * so the tables come back from the installer's own source of truth. Every
 * statement in it is guarded, which is what makes re-running the whole thing
 * cheaper than maintaining a second version of part of it.
 *
 * Reports and exits unless `--apply` is passed.
 *
 * Run via:
 *   pnpm -F @starkeep/admin-installer tsx scripts/recreate-dsql-metadata-tables.ts [--apply]
 */

import "@starkeep/app-client/load-env";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { IAMClient, PutRolePolicyCommand, DeleteRolePolicyCommand } from "@aws-sdk/client-iam";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
import { CATEGORIES, pgMetadataTableName } from "@starkeep/protocol-primitives";
import { initializeSharedSchema } from "../src/dsql-schema-init";

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
    const raw = JSON.parse(readFileSync(cached, "utf8")) as Creds;
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

/** The unqualified names of the tables this script owns, from CATEGORIES. */
function metadataTableNames(): string[] {
  return CATEGORIES.filter((c) => c.id !== "other").map((c) =>
    pgMetadataTableName(c.id).replace(/^shared\./, ""),
  );
}

interface TableState {
  name: string;
  exists: boolean;
  rows: number;
  columns: Array<{ name: string; type: string }>;
  grants: string[];
}

async function readState(client: pg.Client): Promise<TableState[]> {
  const out: TableState[] = [];
  for (const name of metadataTableNames()) {
    const present = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'shared' AND table_name = $1`,
      [name],
    );
    if (present.rows[0].n === 0) {
      out.push({ name, exists: false, rows: 0, columns: [], grants: [] });
      continue;
    }
    const rows = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM shared.${name}`);
    const cols = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'shared' AND table_name = $1
        ORDER BY ordinal_position`,
      [name],
    );
    const grants = await client.query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type FROM information_schema.table_privileges
        WHERE table_schema = 'shared' AND table_name = $1
        ORDER BY grantee, privilege_type`,
      [name],
    );
    out.push({
      name,
      exists: true,
      rows: rows.rows[0].n,
      columns: cols.rows.map((c) => ({ name: c.column_name, type: c.data_type })),
      grants: grants.rows.map((g) => `${g.grantee}:${g.privilege_type}`),
    });
  }
  return out;
}

function printState(label: string, state: TableState[]): void {
  console.log(`\n=== ${label} ===`);
  for (const t of state) {
    if (!t.exists) {
      console.log(`  ${t.name.padEnd(26)} (absent)`);
      continue;
    }
    console.log(
      `  ${t.name.padEnd(26)} rows=${String(t.rows).padEnd(5)} cols=${t.columns.length}` +
        `  grants=[${[...new Set(t.grants.map((g) => g.split(":")[0]))].join(",")}]`,
    );
  }
  const image = state.find((t) => t.name.endsWith("image_metadata"));
  if (image?.exists) {
    console.log(`  shared.${image.name} columns:`);
    for (const c of image.columns) console.log(`    ${c.name.padEnd(20)} ${c.type}`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const cfg = loadStarkeepConfig();
  const region = cfg.region ?? "us-east-2";
  const base = loadBaseCreds();
  const sessionTag = `mdrecreate-${process.pid}`;
  const mgr = await assume(cfg.managerRoleArn, base, `${sessionTag}-mgr`, region);

  const iam = new IAMClient({ region, credentials: mgr });
  const roleName = `${cfg.stackPrefix}-install-ddl-role`;
  const policyName = `temp-install-ddl-mdrecreate-${sessionTag}`;
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
    let before: TableState[];
    try {
      before = await readState(client);
      printState("before", before);

      const occupied = before.filter((t) => t.rows > 0);
      if (occupied.length > 0) {
        throw new Error(
          `refusing to drop: ${occupied.map((t) => `${t.name}=${t.rows}`).join(", ")} hold rows, ` +
            `and nothing refills these tables. Back them up first.`,
        );
      }

      if (!apply) {
        console.log("\nread-only; pass --apply to drop and recreate.");
        return;
      }

      for (const t of before.filter((t) => t.exists)) {
        await client.query(`DROP TABLE shared.${t.name}`);
        console.log(`dropped shared.${t.name}`);
      }
    } finally {
      await client.end().catch(() => {});
    }

    console.log("\nre-running initializeSharedSchema…");
    await initializeSharedSchema({
      hostname: cfg.auroraEndpoint,
      region,
      stackPrefix: cfg.stackPrefix,
      accountId: cfg.accountId,
      credentials: ddl,
    });

    const verify = await connectAsAdminWithRetry(cfg.auroraEndpoint, region, ddl);
    try {
      const recreated = await readState(verify);
      printState("after recreate", recreated);

      const missing = recreated.filter((t) => !t.exists);
      if (missing.length > 0) {
        throw new Error(`not recreated: ${missing.map((t) => t.name).join(", ")}`);
      }

      // Per-app grants are the half a drop-and-recreate silently loses, and
      // nobody would notice until an app 403s on a metadata write.
      // `initializeSharedSchema` issues none of them: they come from
      // `runAppInstallDdl`, which derives them from the app's manifest. On this
      // cluster that is `starkeep_app_photos` on the image and video tables.
      //
      // Re-issuing exactly what stood before the drop restores the state rather
      // than recomputing it. Recomputing would mean running each installed
      // app's full install DDL, which also rewrites IAM role mappings, syncable
      // tables, access grants and label keys — a far wider blast radius than a
      // grant restore, and it would quietly fold in manifest drift that has
      // nothing to do with this change. Drift is its own problem; see
      // `plan-app-upgrade-path-2026-09-10.md`.
      const restored: string[] = [];
      for (const t of recreated) {
        const was = before.find((b) => b.name === t.name);
        if (!was?.exists) continue;
        for (const g of was.grants.filter((g) => !t.grants.includes(g))) {
          const [grantee, privilege] = g.split(":");
          await verify.query(`GRANT ${privilege} ON shared.${t.name} TO "${grantee}"`);
          restored.push(`${t.name}:${g}`);
        }
      }
      if (restored.length > 0) console.log(`\nrestored grants: ${restored.join(", ")}`);

      const after = await readState(verify);
      printState("after grant restore", after);
      const lost = after.flatMap((t) => {
        const was = before.find((b) => b.name === t.name);
        return (was?.grants ?? [])
          .filter((g) => !t.grants.includes(g))
          .map((g) => `${t.name}:${g}`);
      });
      if (lost.length > 0) throw new Error(`grants still missing: ${lost.join(", ")}`);
      console.log("\nevery pre-drop grant is back.");
    } finally {
      await verify.end().catch(() => {});
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
