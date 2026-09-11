/**
 * Re-ship per-category metadata the cloud is missing, by moving its records'
 * clocks.
 *
 * A metadata row has no clock of its own. It rides the record it belongs to
 * and is applied with it (`storage-adapter/src/database/metadata-sync.ts`), so
 * a row whose record sits at or below the peer's watermark is never offered
 * again. Any window where the responder rejected metadata but the records
 * themselves shipped leaves rows stranded exactly that way, permanently.
 *
 * That is not hypothetical. Recreating the metadata tables on 2026-09-10
 * revoked Drive's grants on them (see `docs/schema-change-runbook.md`), and
 * when the 2026-09-11 re-derive finally gave sync metadata to carry, 120 rows
 * — 42 originals and 78 renditions — had already shipped in the last rounds
 * that succeeded. Their `updated_at` values all fell inside one eight-second
 * window below the frozen watermark, and no amount of waiting would move them.
 *
 * Writing each row back through the local data server's metadata route is what
 * unsticks them: the route goes through `sdk.data.putMetadata`, which writes
 * the row and then bumps the record's `updated_at`. **The bump is the point**,
 * and it is why this goes over HTTP rather than straight at the SQLite file —
 * the running daemon owns the HLC clock and the change log, and a second
 * process minting its own timestamps would diverge from both.
 *
 * Idempotent, and safe to run when nothing is wrong. It re-reads the cloud each
 * time and touches only rows genuinely absent there, and every value it writes
 * is one the local row already holds, so a run is a clock bump rather than an
 * edit.
 *
 * Scoped to the categories one app can write, because writing a category's
 * metadata requires an app holding `metadataWrite` on it — Photos covers image
 * and video, which is every category this library populates.
 *
 * Run via:
 *   pnpm -F @starkeep/admin-installer tsx scripts/reship-stranded-metadata.ts \
 *     [--app photos] [--categories image,video] [--apply]
 */

import "@starkeep/app-client/load-env";
import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { IAMClient, PutRolePolicyCommand, DeleteRolePolicyCommand } from "@aws-sdk/client-iam";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
import {
  pgMetadataTableName,
  sqliteMetadataTableName,
  type Category,
} from "@starkeep/protocol-primitives";

interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function loadStarkeepConfig() {
  const dir = process.env.STARKEEP_DIR ?? join(homedir(), ".starkeep");
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
    accountId: string;
    stackPrefix: string;
    managerRoleArn: string;
    auroraEndpoint: string;
    region?: string;
  };
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
  throw new Error("No AWS credentials: set AWS_* env vars or sign in via admin-web.");
}

async function assume(
  arn: string,
  creds: Creds,
  sessionName: string,
  region: string,
): Promise<Creds> {
  const r = await new STSClient({ region, credentials: creds }).send(
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
      const token = await new DsqlSigner({
        hostname,
        region,
        credentials: creds,
      }).getDbConnectAdminAuthToken();
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

/**
 * Mirrors `signRequest` in `@starkeep/app-client/src/sign.ts`.
 *
 * Reimplemented rather than imported because that package's signing entry
 * point expects an app's own credential bundle, and this reads the secret
 * straight out of the local registry as an operator tool. The HMAC input shape
 * — `${appId}:${METHOD}:${path}:${ts}:` bytes ++ body bytes — must stay in step
 * with it and with `validateAppHmac` in the local data server.
 */
function signHeaders(
  appId: string,
  secret: string,
  method: string,
  path: string,
  body: string,
): Record<string, string> {
  const ts = Date.now();
  const prefix = Buffer.from(`${appId}:${method.toUpperCase()}:${path}:${ts}:`, "utf8");
  const input = Buffer.concat([
    prefix as unknown as Uint8Array,
    Buffer.from(body, "utf8") as unknown as Uint8Array,
  ]);
  return {
    "Content-Type": "application/json",
    "X-Starkeep-App-Id": appId,
    "X-Starkeep-App-Sig": createHmac("sha256", secret)
      .update(input as unknown as Uint8Array)
      .digest("hex"),
    "X-Starkeep-App-Ts": String(ts),
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const appId = arg("app") ?? "photos";
  const lds = arg("lds") ?? "http://127.0.0.1:9820";
  const categories = (arg("categories") ?? "image,video")
    .split(",")
    .map((s) => s.trim() as Category);

  const cfg = loadStarkeepConfig();
  const region = cfg.region ?? "us-east-2";
  const mgr = await assume(
    cfg.managerRoleArn,
    loadBaseCreds(),
    `reship-${process.pid}-mgr`,
    region,
  );
  const iam = new IAMClient({ region, credentials: mgr });
  const roleName = `${cfg.stackPrefix}-install-ddl-role`;
  const policyName = `temp-install-ddl-reship-${process.pid}`;
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

  const cloudIds = new Map<Category, Set<string>>();
  try {
    // IAM propagation to the DSQL data-plane authorizer is tens of seconds.
    await new Promise((r) => setTimeout(r, 12_000));
    const ddl = await assume(
      `arn:aws:iam::${cfg.accountId}:role/${roleName}`,
      mgr,
      `reship-${process.pid}-ddl`,
      region,
    );
    const client = await connectAsAdminWithRetry(cfg.auroraEndpoint, region, ddl);
    try {
      for (const category of categories) {
        const rows = await client.query<{ record_id: string }>(
          `SELECT record_id FROM ${pgMetadataTableName(category)}`,
        );
        cloudIds.set(category, new Set(rows.rows.map((r) => r.record_id)));
      }
    } finally {
      await client.end().catch(() => {});
    }
  } finally {
    await iam
      .send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }))
      .catch(() => {});
  }

  // `readOnly` is load-bearing, not a nicety: this script must reach the
  // database only through the daemon's HTTP route, and opening the file
  // read-only is what makes a stray direct write impossible rather than merely
  // absent. The cast is for the installed `@types/node`, whose
  // `DatabaseSyncOptions` predates the option; the runtime honours it.
  const db = new DatabaseSync(join(homedir(), ".starkeep", "data.db"), {
    readOnly: true,
  } as ConstructorParameters<typeof DatabaseSync>[1]);
  const secret = (
    db.prepare(`SELECT hmac_secret FROM shared_app_registry WHERE app_id = ?`).get(appId) as
      | { hmac_secret: string }
      | undefined
  )?.hmac_secret;
  if (!secret) throw new Error(`no hmac_secret for "${appId}" in the local registry`);

  const stranded: Array<{ recordId: string; typeId: string; metadata: Record<string, unknown> }> =
    [];
  for (const category of categories) {
    const have = cloudIds.get(category)!;
    const rows = db
      .prepare(
        `SELECT m.*, r.type AS starkeep_record_type
           FROM ${sqliteMetadataTableName(category)} m
           JOIN shared_records r ON r.id = m.record_id
          WHERE r.deleted_at IS NULL`,
      )
      .all() as Array<Record<string, unknown>>;
    const missing = rows.filter((r) => !have.has(r.record_id as string));
    console.log(`${category}: local ${rows.length}, cloud ${have.size}, absent ${missing.length}`);
    for (const row of missing) {
      // Every stored column but the identity ones, nulls dropped — the write
      // path treats a named column as an overwrite and an absent one as no
      // information, so writing back only what is set keeps this a clock bump.
      const metadata: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === "record_id" || k === "record_type" || k === "starkeep_record_type") continue;
        if (v === null || v === undefined) continue;
        // SQLite hands back 0/1 for a declared boolean; the write path checks
        // types, so hand it the boolean the column declares.
        metadata[k] = k === "exif_present" ? v !== 0 : v;
      }
      if (Object.keys(metadata).length === 0) continue;
      stranded.push({
        recordId: row.record_id as string,
        typeId: row.starkeep_record_type as string,
        metadata,
      });
    }
  }
  db.close();

  console.log(`\n${stranded.length} rows to re-ship`);
  if (stranded.length === 0) return;
  if (!apply) {
    console.log("read-only; pass --apply to re-ship them.");
    return;
  }

  let ok = 0;
  const failures: string[] = [];
  for (const { recordId, typeId, metadata } of stranded) {
    const path = `/data/records/${recordId}/metadata`;
    const body = JSON.stringify({ typeId, metadata });
    const res = await fetch(`${lds}${path}`, {
      method: "POST",
      headers: signHeaders(appId, secret, "POST", path, body),
      body,
    });
    if (res.ok) ok++;
    else
      failures.push(`${recordId} (${typeId}): ${res.status} ${(await res.text()).slice(0, 160)}`);
  }

  console.log(`re-wrote ${ok} of ${stranded.length}`);
  if (failures.length > 0) {
    console.log(`${failures.length} failed:`);
    for (const f of failures.slice(0, 15)) console.log(`  ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nEach write moved its record's clock; the next sync round carries them.");
}

void main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error("FAILED:", err);
    process.exit(1);
  },
);
