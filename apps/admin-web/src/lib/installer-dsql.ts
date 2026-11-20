/**
 * The installer's connection to the cloud cluster, for admin-web routes that
 * read or change deployment tables: the app registry and the public shares.
 *
 * Credentials must be the admin-app session creds (the same ones the
 * cloud-install modal uses). At install time those are mapped to the
 * `${stackPrefix}_installer` PG role via the IAM-to-PG mapping set up by
 * initializeSharedSchema (see admin-installer's dsql-schema-init.ts).
 *
 * The pool itself comes from `@starkeep/operator/cloud-registry`, which the CLI
 * uses too, rather than from @starkeep/admin-installer, because that package
 * transitively pulls Pulumi, which OOMs the dev bundle.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import type pg from "pg";
import { installerPool } from "@starkeep/operator/cloud-registry";
import { requireAdmin } from "./admin-auth";

export { compiler } from "@starkeep/operator/cloud-registry";

const STARKEEP_DIR = starkeepDir();
const CONFIG_PATH = join(STARKEEP_DIR, "config.json");

interface StarkeepConfig {
  stackPrefix?: string;
  userPoolId?: string;
  auroraEndpoint?: string;
}

/**
 * The region, derived from the Cognito pool id rather than stored — the rule
 * `src/lib/cloud-config.ts` states and the reason no `region` field exists.
 *
 * The underscore is what makes it a derivation. AWS spells a pool id
 * `us-east-2_Xxxxx`, so a value with no underscore carries no region, and
 * treating the whole string as one built a DSQL hostname in a region that does
 * not exist — a connection timeout where the answer is "finish cloud setup".
 */
function regionFromUserPoolId(userPoolId: string): string | null {
  const parts = userPoolId.split("_");
  return parts.length > 1 ? parts[0] || null : null;
}

/**
 * A pool on the cloud cluster as `<stackPrefix>_installer`, as the signed-in
 * admin, or the response that says why not.
 *
 * The guards run in a fixed order — the config file, then its contents, then
 * the admin session (401 `NOT_SIGNED_IN`) — and the dashboard's cloud column
 * branches on each answer.
 * The caller ends the pool.
 */
export async function openInstallerPool(
  req: Request,
): Promise<{ pool: pg.Pool; body: Record<string, unknown> } | Response> {
  if (!existsSync(CONFIG_PATH)) {
    return Response.json(
      { error: "Cloud is not configured; finish cloud setup first" },
      { status: 400 },
    );
  }
  let config: StarkeepConfig;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StarkeepConfig;
  } catch {
    return Response.json({ error: "config.json is not valid JSON" }, { status: 500 });
  }

  const stackPrefix = config.stackPrefix;
  const hostname = config.auroraEndpoint;
  const region = config.userPoolId ? regionFromUserPoolId(config.userPoolId) : null;
  if (!stackPrefix || !hostname || !region) {
    return Response.json(
      {
        error:
          "config.json is missing required fields (stackPrefix, userPoolId, auroraEndpoint); finish cloud setup first",
      },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;

  let pool: pg.Pool;
  try {
    pool = await installerPool({
      hostname,
      region,
      stackPrefix,
      credentials: {
        accessKeyId: admin.stsCredentials.accessKeyId,
        secretAccessKey: admin.stsCredentials.secretAccessKey,
        sessionToken: admin.stsCredentials.sessionToken,
      },
    });
  } catch (err) {
    return Response.json(
      { error: `Failed to sign DSQL token: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
  return { pool, body };
}
