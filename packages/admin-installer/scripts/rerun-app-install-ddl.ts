/**
 * Re-run one installed app's DSQL install DDL, to reissue grants a shared-table
 * recreate revoked.
 *
 * This is step 6 of `docs/schema-change-runbook.md`, as a command. **A redeploy
 * does not do it.** `run_dsql_ddl` carries no `alwaysRun` (`orchestrator.ts:271`),
 * so `runStep` skips it the moment the ledger records it done — however many
 * times the cloud data server is reinstalled. Verified on this cluster: the
 * 2026-09-10 reinstall left Drive's `run_dsql_ddl` timestamp at 2026-08-31 and
 * touched only `put_app_creds_parameter`, its one `alwaysRun` step.
 *
 * It calls `runAppInstallDdl` directly rather than clearing the ledger, which
 * is the other permitted route. Clearing is coarser — it re-runs role creation,
 * the S3 keep file and registration too — and clearing a *single* row is the
 * unsafe move the runbook warns against, because `run_dsql_ddl` depends on
 * `attach_temp_install_ddl_policy`, which has no `alwaysRun` either. A direct
 * call touches no ledger row at all, which is why an app repaired this way
 * keeps its original install timestamp.
 *
 * Every statement `runAppInstallDdl` issues is idempotent — `IF NOT EXISTS`,
 * probe-then-act, `ON CONFLICT` — so running it against a healthy app is a
 * no-op, and running it twice is the same as running it once.
 *
 * Only the built-in Drive manifest is resolved here. Drive is the app this
 * failure mode reaches first and hardest: it is the User-Data-Owner, it ships
 * every shared record the user owns, and having no Lambda and no compute stack
 * it is the one a redeploy most looks like it covered. An installed app's
 * manifest lives outside this package, so pass `--manifest <path>` for those.
 *
 * Run via:
 *   pnpm -F @starkeep/admin-installer tsx scripts/rerun-app-install-ddl.ts \
 *     --app starkeep-drive [--manifest <path>] [--apply]
 */

import "@starkeep/app-client/load-env";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { appManifestSchema } from "@starkeep/admin-manifest";
import { roleChain, type AwsCredentials } from "../src/session";
import { attachTempInstallDdlPolicy, detachTempInstallDdlPolicy } from "../src/iam";
import { runAppInstallDdl, type DsqlDdlOptions } from "../src/dsql-ddl";

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

/**
 * Base credentials for the role chain.
 *
 * `expiration` is required by `AwsCredentials` and neither source carries a
 * meaningful one — env vars have none and the cached file's is advisory. It is
 * only read by callers that pre-emptively refresh, and `roleChain` assumes a
 * fresh session off these immediately, so a far-future stamp is honest about
 * what is known rather than a guess at a real expiry.
 */
function loadBaseCreds(): AwsCredentials {
  const neverExpires = new Date(8640000000000000 / 2);
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      sessionToken: AWS_SESSION_TOKEN ?? "",
      expiration: neverExpires,
    };
  }
  const cached = join(homedir(), ".starkeep", "cloud-credentials.json");
  if (existsSync(cached)) {
    const raw = JSON.parse(readFileSync(cached, "utf8")) as Partial<AwsCredentials> & {
      expiration?: string;
    };
    if (!raw.accessKeyId || !raw.secretAccessKey) {
      throw new Error(`${cached} carries no access key; sign in via admin-web.`);
    }
    return {
      accessKeyId: raw.accessKeyId,
      secretAccessKey: raw.secretAccessKey,
      sessionToken: raw.sessionToken ?? "",
      expiration: raw.expiration ? new Date(raw.expiration) : neverExpires,
    };
  }
  throw new Error(
    "No AWS credentials: set AWS_* env vars or sign in via admin-web (which writes ~/.starkeep/cloud-credentials.json).",
  );
}

/** Built-in manifests this package can resolve on its own. */
function builtinManifestPath(appId: string): string | null {
  if (appId !== "starkeep-drive") return null;
  // `import.meta.url` rather than `__dirname`: tsx runs this file as ESM.
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "builtin-apps",
    "starkeep-drive",
    "manifest.json",
  );
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const appId = arg("app") ?? "starkeep-drive";
  const manifestPath = arg("manifest") ?? builtinManifestPath(appId);
  if (!manifestPath) {
    throw new Error(
      `No built-in manifest for "${appId}"; pass --manifest <path> to its manifest.json.`,
    );
  }

  // Parsed through the schema rather than read raw, so defaults are filled the
  // same way `installApp` sees them — the DDL is driven by `infraRequirements`,
  // and an unparsed manifest would silently omit whatever it leaves implicit.
  const manifest = appManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const ir = manifest.infraRequirements;

  console.log(`app:       ${appId}`);
  console.log(`manifest:  ${manifestPath}`);
  console.log(`fileAccess:    ${ir.fileAccess.length} entries`);
  console.log(`fileAccessAll: ${ir.fileAccessAll}`);
  console.log(
    `syncable:      ${ir.appSpecificSyncable.tables.length} tables, files=${ir.appSpecificSyncable.files}`,
  );
  console.log(`labelKeys:     ${ir.labelKeys.length}`);

  if (!apply) {
    console.log("\nread-only; pass --apply to run the DDL.");
    return;
  }

  const cfg = loadStarkeepConfig();
  const region = cfg.region ?? "us-east-2";
  const managerCreds = await roleChain([cfg.managerRoleArn], {
    baseCredentials: loadBaseCreds(),
  });

  // Same attach / run / detach shape as the orchestrator, through the same
  // helpers, so the policy name and contents match what an install would use.
  console.log("\nattaching temp install-ddl policy…");
  await attachTempInstallDdlPolicy(cfg.stackPrefix, appId, managerCreds);
  try {
    // IAM propagation to the DSQL data-plane authorizer is tens of seconds.
    await new Promise((r) => setTimeout(r, 12_000));
    const ddlCreds = await roleChain(
      [`arn:aws:iam::${cfg.accountId}:role/${cfg.stackPrefix}-install-ddl-role`],
      { baseCredentials: managerCreds },
    );
    const opts: DsqlDdlOptions = {
      hostname: cfg.auroraEndpoint,
      region,
      stackPrefix: cfg.stackPrefix,
      accountId: cfg.accountId,
      credentials: ddlCreds,
    };
    console.log("running install DDL…");
    await runAppInstallDdl(
      opts,
      appId,
      ir.fileAccess,
      ir.fileAccessAll,
      ir.appSpecificSyncable.tables,
      ir.appSpecificSyncable.files,
      ir.labelKeys,
    );
    console.log("install DDL complete.");
  } finally {
    console.log("detaching temp install-ddl policy…");
    await detachTempInstallDdlPolicy(cfg.stackPrefix, appId, managerCreds).catch(() => {});
  }

  console.log(
    "\nVerify with scripts/recreate-dsql-metadata-tables.ts (read-only) — its\n" +
      "per-app grant audit should no longer name this app.",
  );
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error("FAILED:", err);
    process.exit(1);
  },
);
