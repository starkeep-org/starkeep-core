#!/usr/bin/env tsx
/**
 * Uninstall a Starkeep app from the cloud — the counterpart of
 * cli-install-app. Runs the orchestrator's uninstall state machine: compute
 * stack and bundle down, grants and the DSQL login mapping revoked, IAM roles
 * and the SSM app-creds parameter deleted, registry row closed out.
 *
 * Uninstall removes the app and keeps its data. The app's `app_<appId>` schema
 * and its files under `apps/<appId>/` stay, and a reinstall gets them back.
 * Shared records the app created stay too; they belong to the user, not the
 * app. Deleting the app's own data is a separate command,
 * `cli:delete-app-data`.
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
 * use. With neither flag, the uninstall removes the app entirely. It deletes
 * no app data either way, so it asks for no typed confirmation.
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { AppManifest } from "@starkeep/admin-manifest";
import { uninstallApp, type AppSurface } from "../src/orchestrator";
import { createDsqlRegistry } from "../src/registry";
import { exitOnInstallFailure } from "../src/cli-exit";
import { regionFromUserPoolId } from "../src/cognito-auth";
import { useOnlyAwsCredentials } from "../src/aws-env";
import {
  loadStarkeepCliConfig,
  appDirFor,
  deriveInstallerArns,
  manifestForUninstall,
  takeAppDirFlag,
  starkeepConfigPath,
} from "../src/app-cli-config";
import { adminScriptCredentialsOrExit } from "./admin-credentials";

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

// Credentials from the environment, as admin-web and the e2e harness pass
// them, else from the admin session `starkeep login --admin` keeps.
useOnlyAwsCredentials(
  await adminScriptCredentialsOrExit(nonInteractive),
  process.env.AWS_REGION ?? region,
);

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
    : `\n${appId} cloud uninstall complete. Its data stays in the cloud, and reinstalling ` +
        `${appId} gets it back. To delete it, run cli:delete-app-data ${appId}.`,
);
