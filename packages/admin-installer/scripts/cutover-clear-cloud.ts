/**
 * One-time cutover: clear the cloud's user data for the per-user layout.
 *
 * The per-user layout puts the owner in every object key and first in every
 * owned table's primary key. The live cloud's data predates both, and the
 * cutover decision was to clear it and let each node sync its library up again
 * (plan-multi-user-roles-2026-10-16.md, decision 1 and step 4.10). This script
 * does the clearing:
 *
 *   - S3: deletes every object under `shared/`, and every object under `apps/`
 *     except each app's `.keep` marker. `_starkeep/` (inventory) stays.
 *   - DSQL: drops the shared owned tables — records, labels, availability and
 *     every metadata table — so the cloud data server's reinstall recreates
 *     them with `user_id`, and every table in every app schema, so each app's
 *     reinstall recreates its tables the same way (the install DDL creates
 *     tables `IF NOT EXISTS`, and would keep an old one). The schemas, the
 *     roles and the deployment's own tables (registry, grants, label keys,
 *     namespaces, install steps) stay. Each app's reinstall restores its
 *     grants on the recreated tables.
 *   - SSM: deletes the device records phase 2 moved away from
 *     `/<prefix>/app-creds/_device-*`, which no longer count.
 *
 * It runs as the AWS account's administrator — the CLI's default credential
 * chain — not through Starkeep's own roles. Clearing every user's data is no
 * job any Starkeep identity holds: the admin role has no shared-data access by
 * design, and every data role is scoped to one user. A one-off operator act
 * belongs to the account owner.
 *
 *   AWS_PROFILE=default pnpm -F @starkeep/admin-installer exec tsx scripts/cutover-clear-cloud.ts          # dry run: counts only
 *   AWS_PROFILE=default pnpm -F @starkeep/admin-installer exec tsx scripts/cutover-clear-cloud.ts --yes    # clear
 */

import "@starkeep/app-client/load-env";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { SSMClient, GetParametersByPathCommand, DeleteParameterCommand } from "@aws-sdk/client-ssm";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
import { CATEGORIES, hasMetadataTable } from "@starkeep/protocol-primitives";

const APPLY = process.argv.includes("--yes");

const config = JSON.parse(
  readFileSync(
    join(process.env.STARKEEP_DIR ?? join(homedir(), ".starkeep"), "config.json"),
    "utf8",
  ),
) as { stackPrefix: string; auroraEndpoint: string; s3Bucket: string; region?: string };
const region = config.region ?? "us-east-2";

/** The shared tables that hold one user's rows, and so predate the owner column. */
const OWNED_SHARED_TABLES = [
  "shared.records",
  "shared.record_labels",
  "shared.object_availability",
  ...CATEGORIES.filter((c) => hasMetadataTable(c.id)).map((c) => `shared.record_${c.id}_metadata`),
];

async function s3Keys(s3: S3Client, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.s3Bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}

async function main(): Promise<void> {
  const s3 = new S3Client({ region });
  const ssm = new SSMClient({ region });

  const shared = await s3Keys(s3, "shared/");
  const apps = (await s3Keys(s3, "apps/")).filter((k) => !k.endsWith("/.keep"));
  const devices: string[] = [];
  let token: string | undefined;
  do {
    const page = await ssm.send(
      new GetParametersByPathCommand({
        Path: `/${config.stackPrefix}/app-creds/`,
        NextToken: token,
      }),
    );
    for (const p of page.Parameters ?? []) if (p.Name?.includes("/_device-")) devices.push(p.Name);
    token = page.NextToken;
  } while (token);

  console.log(
    `S3 ${config.s3Bucket}: ${shared.length} objects under shared/, ${apps.length} under apps/ (not .keep)`,
  );
  console.log(`SSM: ${devices.length} old device records: ${devices.join(" ")}`);

  const password = await new DsqlSigner({
    hostname: config.auroraEndpoint,
    region,
  }).getDbConnectAdminAuthToken();
  const client = new pg.Client({
    host: config.auroraEndpoint,
    port: 5432,
    database: "postgres",
    user: "admin",
    password,
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();
  try {
    for (const table of OWNED_SHARED_TABLES) {
      const exists = await client.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [table]);
      if (!exists.rows[0]?.e) {
        console.log(`DSQL ${table}: absent`);
        continue;
      }
      const n = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
      console.log(`DSQL ${table}: ${n.rows[0]?.n} rows`);
    }
    const appTables = (
      await client.query(
        `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
          WHERE table_schema LIKE 'app\\_%' ORDER BY 1`,
      )
    ).rows.map((r) => r.t as string);
    for (const table of appTables) {
      const n = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
      console.log(`DSQL ${table}: ${n.rows[0]?.n} rows`);
    }

    if (!APPLY) {
      console.log("\nDry run. Pass --yes to clear.");
      return;
    }
    for (const table of [...OWNED_SHARED_TABLES, ...appTables]) {
      // One statement each: DSQL runs DDL one statement per transaction.
      await client.query(`DROP TABLE IF EXISTS ${table}`);
      console.log(`dropped ${table}`);
    }
  } finally {
    await client.end();
  }

  const objects = [...shared, ...apps];
  for (let i = 0; i < objects.length; i += 1000) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: config.s3Bucket,
        Delete: { Objects: objects.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
  console.log(`deleted ${objects.length} objects`);
  for (const name of devices) {
    await ssm.send(new DeleteParameterCommand({ Name: name }));
    console.log(`deleted ${name}`);
  }
  console.log("\nCleared. Reinstall the cloud data server, then Drive, then each cloud app.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
