#!/usr/bin/env tsx
/**
 * Uninstall a Starkeep app from the cloud — the counterpart of
 * cli-install-app. Runs the orchestrator's uninstall state machine: compute
 * stack down, S3 artifacts/files gone, per-app DSQL schema and PG role
 * dropped, SSM app-creds parameter deleted, registry row closed out. Shared
 * records the app created are deliberately left in place (they belong to the
 * user, not the app).
 *
 * The uninstall DDL needs the app's declared app-specific tables, so it reads
 * the manifest the cloud registry stored at install. A registry row that
 * predates the stored manifest falls back to the app's source folder
 * (`--app-dir`, or the same discovery as install).
 *
 * Usage:
 *   pnpm --filter @starkeep/admin-installer cli:uninstall-app <appId>
 *   pnpm --filter @starkeep/admin-installer cli:uninstall-app <appId> --non-interactive
 *   pnpm --filter @starkeep/admin-installer cli:uninstall-app <appId> --web
 *   pnpm --filter @starkeep/admin-installer cli:uninstall-app <appId> --mobile
 *   pnpm --filter @starkeep/admin-installer cli:uninstall-app <appId> --app-dir <folder>
 *
 * `--web` removes only the cloud web app (its compute), and `--mobile` only the
 * mobile app (its Android identity and sign-in callback). Either keeps the
 * app's data side, which the other surface and the desktop's sync may still
 * use. With neither flag, the uninstall removes the app entirely, and an
 * interactive run asks the operator to type the app id first, because it
 * deletes the app's own cloud data. `--non-interactive` skips that question.
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { AppManifest } from "@starkeep/admin-manifest";
import { uninstallApp, type AppSurface } from "../src/orchestrator";
import { createDsqlRegistry } from "../src/registry";
import { exitOnInstallFailure } from "../src/cli-exit";
import {
  regionFromUserPoolId,
  cognitoPasswordAuth,
  getIdentityPoolCredentials,
} from "../src/cognito-auth";
import { prompt } from "../src/cli-prompt";
import {
  loadStarkeepCliConfig,
  appDirFor,
  deriveInstallerArns,
  manifestForUninstall,
  takeAppDirFlag,
  starkeepConfigPath,
} from "../src/app-cli-config";

let flags: string[];
let appDirFlag: string | undefined;
try {
  ({ appDir: appDirFlag, rest: flags } = takeAppDirFlag(process.argv.slice(2)));
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const nonInteractive = flags.includes("--non-interactive");
// The surfaces to remove; none named removes the app entirely.
const surfaces: AppSurface[] = [
  ...(flags.includes("--web") ? (["web"] as const) : []),
  ...(flags.includes("--mobile") ? (["mobile"] as const) : []),
];
const appId = flags.find((f) => !f.startsWith("--"));

if (!appId) {
  console.error(
    "Usage: cli:uninstall-app <appId> [--non-interactive] [--web] [--mobile] [--app-dir <folder>]",
  );
  process.exit(1);
}

let config: ReturnType<typeof loadStarkeepCliConfig>;
try {
  config = loadStarkeepCliConfig();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const region = regionFromUserPoolId(config.userPoolId);
const stackPrefix = config.stackPrefix;

if (!config.apiGatewayId || !config.authorizerId || !config.s3Bucket || !config.auroraEndpoint) {
  console.error(
    `Error: ${starkeepConfigPath()} is missing required fields: ` +
      "apiGatewayId, authorizerId, s3Bucket, auroraEndpoint.\n" +
      "There is no cloud-data-server install to uninstall apps from.",
  );
  process.exit(1);
}

if (nonInteractive) {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_SESSION_TOKEN) {
    console.error(
      "--non-interactive requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN env vars",
    );
    process.exit(1);
  }
} else {
  const email = await prompt("Email: ");
  const password = await prompt("Password: ", true);
  console.log("\nAuthenticating with Cognito…");
  const idToken = await cognitoPasswordAuth(config, email, password, async () => {
    console.log("\nThis account requires a new password (first login).");
    const newPw = await prompt("New password: ", true);
    const confirmPw = await prompt("Confirm new password: ", true);
    if (newPw !== confirmPw) {
      console.error("Passwords do not match.");
      process.exit(1);
    }
    return newPw;
  });
  console.log("Fetching temporary AWS credentials…");
  const creds = await getIdentityPoolCredentials(config, idToken);
  process.env.AWS_ACCESS_KEY_ID = creds.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.sessionToken;
  process.env.AWS_REGION = region;
}

// Derive account ID from STS if not already in config.
let accountId: string;
if (config.accountId) {
  accountId = config.accountId;
} else {
  const sts = new STSClient({ region });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  if (!identity.Account) {
    console.error("Error: could not determine AWS account ID from credentials");
    process.exit(1);
  }
  accountId = identity.Account;
}

const {
  managerRoleArn,
  installDdlRoleArn,
  installInfraRoleArn,
  apiGatewayExecutionArn,
  permissionsBoundaryArn,
  foundationalPermissionsBoundaryArn,
  userDataOwnerPermissionsBoundaryArn,
  pulumiStateBucket,
  artifactsBucket,
} = deriveInstallerArns(config, accountId, region);

const registryCredentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  sessionToken: process.env.AWS_SESSION_TOKEN!,
};

const manifestRegistry = createDsqlRegistry({
  hostname: config.auroraEndpoint,
  region,
  stackPrefix,
  credentials: registryCredentials,
});
let manifest: AppManifest;
try {
  const found = await manifestForUninstall(manifestRegistry, appId, () =>
    appDirFor(config, appId, appDirFlag),
  );
  manifest = found.manifest;
  if (found.from === "folder") {
    console.log("The cloud registry holds no manifest for this app; using its source folder.");
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  await manifestRegistry.close();
}

console.log(`\nStarkeep ${appId} cloud uninstall`);
console.log(`  Region : ${region}`);
console.log(`  Stage  : ${stackPrefix}`);
console.log(`  Account: ${accountId}`);
console.log("");

// A full uninstall deletes the app's own cloud data. Removing one surface
// keeps the data side, so it asks nothing. A non-interactive run is the
// caller's own decision, as with its credentials.
if (surfaces.length === 0 && !nonInteractive) {
  console.log(
    `This deletes ${appId}'s own data in the cloud: the tables in its ` +
      `app_${appId.replace(/-/g, "_")} schema, its files under apps/${appId}/ in ` +
      `${config.s3Bucket}, and its public links. Records it shared with other ` +
      "apps stay.\n",
  );
  const answer = await prompt(`Type ${appId} to uninstall it: `);
  if (answer.trim() !== appId) {
    console.log("Uninstall cancelled. Nothing changed.");
    process.exit(1);
  }
}

await uninstallApp({
  appId,
  manifest,
  registryCredentials,
  ...(surfaces.length > 0 ? { surfaces } : {}),
  config: {
    stackPrefix,
    region,
    accountId,
    dsqlHostname: config.auroraEndpoint,
    filesBucket: config.s3Bucket,
    artifactsBucket,
    pulumiStateBucket,
    apiGatewayId: config.apiGatewayId,
    apiGatewayExecutionArn,
    apiGatewayUrl: config.apiGatewayUrl ?? "",
    authorizerId: config.authorizerId,
    permissionsBoundaryArn,
    foundationalPermissionsBoundaryArn,
    userDataOwnerPermissionsBoundaryArn,
    managerRoleArn,
    installDdlRoleArn,
    installInfraRoleArn,
    ...(config.mobileAppsUserPoolClientId
      ? {
          mobileSignIn: {
            userPoolId: config.userPoolId,
            mobileAppsClientId: config.mobileAppsUserPoolClientId,
          },
        }
      : {}),
  },
}).catch(exitOnInstallFailure);

console.log(
  surfaces.length > 0
    ? `\n${appId}'s ${surfaces.join(" and ")} app removed; its data stays installed.`
    : `\n${appId} cloud uninstall complete.`,
);
