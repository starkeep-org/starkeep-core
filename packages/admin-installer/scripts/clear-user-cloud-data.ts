/**
 * Delete one user's data from the cloud: every row that user owns and every
 * object under that user's segment.
 *
 * The per-user layout puts the owner in each owned table's `user_id` column and
 * in every object key (`shared/<userId>/…`, `apps/<appId>/<userId>/…`), so one
 * user's data is exactly those rows and those prefixes. Unlike
 * `cutover-clear-cloud.ts`, this drops no table and touches no other user.
 *
 * It refuses while the user is still in the data group. Removing the group
 * first makes the broker refuse the user's calls, so no device can write while
 * the rows go, and the deletion is the second of two deliberate acts.
 *
 * It runs as the AWS account's administrator, for the reason
 * `cutover-clear-cloud.ts` gives: no Starkeep identity may delete a user's data.
 * The bucket policy's `DenyCrossAppPrefixAccess` still denies `apps/*` to a
 * principal without a matching `starkeep:appId` tag, the administrator
 * included, so app objects need a principal tagged for that app. The script
 * reads `DeleteObjects` errors and reports each app prefix it could not clear,
 * rather than counting a denied delete as done.
 *
 *   AWS_PROFILE=default pnpm -F @starkeep/admin-installer exec tsx scripts/clear-user-cloud-data.ts --user <sub>          # dry run
 *   AWS_PROFILE=default pnpm -F @starkeep/admin-installer exec tsx scripts/clear-user-cloud-data.ts --user <sub> --yes    # delete
 *
 * Add `--apps-only <appId>` to delete just that app's objects, as a principal
 * tagged `starkeep:appId=<appId>`.
 */

import "@starkeep/app-client/load-env";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
import { DATA_GROUP } from "@starkeep/protocol-primitives";

const args = process.argv.slice(2);
const APPLY = args.includes("--yes");
const userId = args[args.indexOf("--user") + 1];
const appsOnly = args.includes("--apps-only") ? args[args.indexOf("--apps-only") + 1] : null;
if (!args.includes("--user") || !userId || !/^[0-9a-f-]{36}$/.test(userId)) {
  console.error("--user <cognito sub> is required");
  process.exit(2);
}

const config = JSON.parse(
  readFileSync(
    join(process.env.STARKEEP_DIR ?? join(homedir(), ".starkeep"), "config.json"),
    "utf8",
  ),
) as { auroraEndpoint: string; s3Bucket: string; userPoolId: string; region?: string };
const region = config.region ?? "us-east-2";

/** DSQL caps the rows one transaction may change, and each DELETE here is one transaction. */
const DSQL_ROW_LIMIT = 3000;

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

/** The app ids that hold objects under `apps/`, from the bucket's top-level prefixes. */
async function appIds(s3: S3Client): Promise<string[]> {
  const page = await s3.send(
    new ListObjectsV2Command({ Bucket: config.s3Bucket, Prefix: "apps/", Delimiter: "/" }),
  );
  return (page.CommonPrefixes ?? []).map((p) => p.Prefix!.slice("apps/".length, -1));
}

/** Delete `keys`, and return how many S3 refused. */
async function deleteKeys(s3: S3Client, keys: string[]): Promise<number> {
  let refused = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const out = await s3.send(
      new DeleteObjectsCommand({
        Bucket: config.s3Bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    );
    refused += out.Errors?.length ?? 0;
    if (out.Errors?.[0]) console.log(`  refused: ${out.Errors[0].Code} on ${out.Errors[0].Key}`);
  }
  return refused;
}

async function main(): Promise<void> {
  const cognito = new CognitoIdentityProviderClient({ region });
  const found = await cognito.send(
    new ListUsersCommand({ UserPoolId: config.userPoolId, Filter: `sub = "${userId}"` }),
  );
  const user = found.Users?.[0];
  if (!user?.Username) throw new Error(`no user with sub ${userId} in ${config.userPoolId}`);
  const email = user.Attributes?.find((a) => a.Name === "email")?.Value ?? user.Username;
  const groups = await cognito.send(
    new AdminListGroupsForUserCommand({ UserPoolId: config.userPoolId, Username: user.Username }),
  );
  const inDataGroup = (groups.Groups ?? []).some((g) => g.GroupName === DATA_GROUP);
  console.log(`User ${email} (${userId}), data group: ${inDataGroup ? "yes" : "no"}`);

  const s3 = new S3Client({ region });
  const shared = appsOnly ? [] : await s3Keys(s3, `shared/${userId}/`);
  const apps = new Map<string, string[]>();
  for (const app of appsOnly ? [appsOnly] : await appIds(s3)) {
    const keys = await s3Keys(s3, `apps/${app}/${userId}/`);
    if (keys.length > 0) apps.set(app, keys);
  }
  console.log(`S3 shared/${userId}/: ${shared.length} objects`);
  for (const [app, keys] of apps) console.log(`S3 apps/${app}/${userId}/: ${keys.length} objects`);

  const tables: { table: string; rows: number }[] = [];
  if (!appsOnly) {
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
      const owned = (
        await client.query(
          `SELECT table_schema || '.' || table_name AS t FROM information_schema.columns
            WHERE column_name = 'user_id' AND (table_schema = 'shared' OR table_schema LIKE 'app\\_%')
            ORDER BY 1`,
        )
      ).rows.map((r) => r.t as string);
      for (const table of owned) {
        const n = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [
          userId,
        ]);
        const rows = n.rows[0]?.n as number;
        if (rows > 0) tables.push({ table, rows });
      }
      for (const { table, rows } of tables) console.log(`DSQL ${table}: ${rows} rows`);
      const tooBig = tables.find((t) => t.rows > DSQL_ROW_LIMIT);
      if (tooBig)
        throw new Error(
          `${tooBig.table} holds ${tooBig.rows} rows, above DSQL's ${DSQL_ROW_LIMIT} per transaction`,
        );

      if (!APPLY) {
        console.log("\nDry run. Pass --yes to delete.");
        return;
      }
      if (inDataGroup) throw new Error(`Remove ${email} from ${DATA_GROUP} first.`);
      for (const { table } of tables) {
        const out = await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
        console.log(`deleted ${out.rowCount} rows from ${table}`);
      }
    } finally {
      await client.end();
    }
  } else if (!APPLY) {
    console.log("\nDry run. Pass --yes to delete.");
    return;
  } else if (inDataGroup) {
    throw new Error(`Remove ${email} from ${DATA_GROUP} first.`);
  }

  if (shared.length > 0) {
    const refused = await deleteKeys(s3, shared);
    console.log(
      `deleted ${shared.length - refused} of ${shared.length} objects under shared/${userId}/`,
    );
  }
  for (const [app, keys] of apps) {
    const refused = await deleteKeys(s3, keys);
    console.log(
      `deleted ${keys.length - refused} of ${keys.length} objects under apps/${app}/${userId}/`,
    );
    if (refused > 0) {
      console.log(`  Rerun with --apps-only ${app} as a principal tagged starkeep:appId=${app}.`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
