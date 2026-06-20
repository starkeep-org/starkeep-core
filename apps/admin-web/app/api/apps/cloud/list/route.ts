/**
 * Cloud install registry read endpoint.
 *
 * POST with the user's STS credentials in the body; returns the list of
 * currently-installed cloud apps from `shared.app_registry`. This is the
 * single source of truth for "which apps are installed in this cloud
 * stack" — the orchestrator's register_app step writes to it on install
 * completion, and delete_app_registry removes the row on uninstall.
 *
 * Credentials must be the admin-app session creds (the same ones the
 * cloud-install modal uses). At install time those are mapped to the
 * `${stackPrefix}_installer` PG role via the IAM-to-PG mapping set up by
 * initializeSharedSchema (see admin-installer's dsql-schema-init.ts).
 *
 * The route inlines the DSQL connection rather than importing from
 * @starkeep/admin-installer because that package transitively pulls Pulumi,
 * which OOMs the dev bundle (see next.config.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { NextRequest, NextResponse } from "next/server";
import pg from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";

const STARKEEP_DIR = starkeepDir();
const CONFIG_PATH = join(STARKEEP_DIR, "config.json");

interface StarkeepConfig {
  stackPrefix?: string;
  userPoolId?: string;
  auroraEndpoint?: string;
}

function regionFromUserPoolId(userPoolId: string): string | null {
  const region = userPoolId.split("_")[0];
  return region || null;
}

function installerPgUser(stackPrefix: string): string {
  return `${stackPrefix}_installer`.toLowerCase().replace(/-/g, "_");
}

export async function POST(req: NextRequest) {
  if (!existsSync(CONFIG_PATH)) {
    return NextResponse.json(
      { error: "Cloud is not configured; finish cloud setup first" },
      { status: 400 },
    );
  }
  let config: StarkeepConfig;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StarkeepConfig;
  } catch {
    return NextResponse.json({ error: "config.json is not valid JSON" }, { status: 500 });
  }

  const stackPrefix = config.stackPrefix;
  const hostname = config.auroraEndpoint;
  const region = config.userPoolId ? regionFromUserPoolId(config.userPoolId) : null;
  if (!stackPrefix || !hostname || !region) {
    return NextResponse.json(
      {
        error:
          "config.json is missing required fields (stackPrefix, userPoolId, auroraEndpoint); finish cloud setup first",
      },
      { status: 400 },
    );
  }

  const body = (await req.json()) as {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
  if (!body.accessKeyId || !body.secretAccessKey || !body.sessionToken) {
    return NextResponse.json(
      { error: "accessKeyId, secretAccessKey, sessionToken required" },
      { status: 400 },
    );
  }

  const signer = new DsqlSigner({
    hostname,
    region,
    credentials: {
      accessKeyId: body.accessKeyId,
      secretAccessKey: body.secretAccessKey,
      sessionToken: body.sessionToken,
    },
  });
  let token: string;
  try {
    token = await signer.getDbConnectAuthToken();
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to sign DSQL token: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  const pool = new pg.Pool({
    host: hostname,
    port: 5432,
    database: "postgres",
    user: installerPgUser(stackPrefix),
    password: token,
    ssl: { rejectUnauthorized: true },
    max: 1,
  });

  try {
    const result = await pool.query<{
      app_id: string;
      version: string;
      name: string | null;
      installed_at: Date;
      updated_at: Date;
    }>(
      `SELECT app_id, version, name, installed_at, updated_at
       FROM shared.app_registry
       ORDER BY installed_at ASC`,
    );
    return NextResponse.json({
      apps: result.rows.map((r) => ({
        appId: r.app_id,
        version: r.version,
        name: r.name,
        installedAt: r.installed_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `DSQL query failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  } finally {
    await pool.end().catch(() => {});
  }
}
