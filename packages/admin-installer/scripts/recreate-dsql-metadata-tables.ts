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

/**
 * Report which app roles hold metadata-table grants, and name the ones holding
 * none.
 *
 * The signature is a role that can **write** `shared.records` and cannot touch
 * a single metadata table. Writing records and deriving metadata about them go
 * together — `runAppInstallDdl` issues both from one manifest — so holding the
 * first without the second is a state no install produces. It is the state
 * `starkeep_app_starkeep_drive` was found in on 2026-09-11, after Phase A's
 * recreate on 2026-09-10 revoked its grants and no DDL re-ran to restore them,
 * with every sync exchange 500ing on `42501`.
 *
 * Write access is the discriminant rather than any access, because a read-only
 * consumer legitimately needs no metadata grant. `starkeep_app_memo` holds
 * `SELECT` on `shared.records` and nothing else, declares no file access, and
 * would otherwise be reported here every run — a check that cries wolf on a
 * healthy app is one an operator learns to skip.
 *
 * It reports rather than repairs on purpose. Whether a given role *should* hold
 * these grants is a question only its manifest answers, and this script has no
 * business reading three apps' manifests to find out. Naming the suspects is
 * what turns a silent 42501 weeks later into a line of output now.
 */
async function auditAppGrants(client: pg.Client): Promise<void> {
  const rows = (
    await client.query<{ grantee: string; metadata_tables: number; writes_records: boolean }>(
      `SELECT grantee,
              count(DISTINCT table_name) FILTER (
                WHERE table_name LIKE 'record\\_%\\_metadata') ::int AS metadata_tables,
              bool_or(table_name = 'records' AND privilege_type = 'INSERT') AS writes_records
         FROM information_schema.table_privileges
        WHERE table_schema = 'shared' AND grantee LIKE 'starkeep\\_app\\_%'
        GROUP BY grantee ORDER BY grantee`,
    )
  ).rows;

  console.log("\n=== per-app grant audit ===");
  const suspect: string[] = [];
  for (const r of rows) {
    const note = r.metadata_tables === 0 && r.writes_records ? "  <-- NO metadata grants" : "";
    if (note) suspect.push(r.grantee);
    console.log(
      `  ${r.grantee.padEnd(30)} writes records=${String(r.writes_records).padEnd(5)} ` +
        `metadata tables=${r.metadata_tables}${note}`,
    );
  }
  if (suspect.length > 0) {
    console.log(
      `\n  ${suspect.join(", ")} writes shared.records and cannot touch any metadata\n` +
        `  table. No install produces that: every metadata apply fails with 42501 and\n` +
        `  takes the whole sync exchange down with it, so shared-record sync is off for\n` +
        `  that app entirely. Re-run its install DDL — step 6 of\n` +
        `  docs/schema-change-runbook.md. Clearing one ledger row is the unsafe move;\n` +
        `  clear the whole ledger or call runAppInstallDdl directly.`,
    );
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
        await auditAppGrants(client);
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
      // `runAppInstallDdl`, which derives them from the app's manifest.
      //
      // **Restoring the snapshot is a floor, not a repair.** It guarantees the
      // recreate leaves nothing worse than it found, and it guarantees nothing
      // else — if a role was already missing a grant it should hold, this puts
      // the same hole back. That is not hypothetical. Phase A recreated these
      // tables on 2026-09-10 and revoked every app's metadata access with them;
      // Photos got its own back only because its install DDL was re-run that
      // day for an unrelated reason, and `starkeep_app_starkeep_drive` was
      // still holding nothing when this script first ran on 2026-09-11 — with
      // every Drive sync exchange 500ing on `42501 permission denied`.
      //
      // The authoritative repair after any recreate is re-running **every**
      // installed app's install DDL. Nothing here can do that: the ledger marks
      // `run_dsql_ddl` done and only the infra steps carry `alwaysRun`, so no
      // reinstall of the cloud data server will ever reissue these — however
      // many times it runs. The audit below is what makes the gap visible
      // instead of silent.
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
      await auditAppGrants(verify);
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
