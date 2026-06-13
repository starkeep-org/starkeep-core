#!/usr/bin/env tsx
/**
 * Uninstall a Starkeep app from the cloud — the counterpart of
 * cli-install-app. Runs the orchestrator's uninstall state machine: compute
 * stack down, S3 artifacts/files gone, per-app DSQL schema and PG role
 * dropped, SSM app-creds parameter deleted, registry row closed out. Shared
 * records the app created are deliberately left in place (they belong to the
 * user, not the app).
 *
 * The manifest is still resolved from the app's source dir (same discovery as
 * install) because the uninstall DDL needs the declared app-specific tables.
 *
 * Usage:
 *   pnpm --filter @starkeep/admin-installer cli:uninstall-app <appId>
 *   pnpm --filter @starkeep/admin-installer cli:uninstall-app <appId> --non-interactive
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { appManifestSchema } from "@starkeep/admin-manifest";
import { uninstallApp } from "../src/orchestrator";
import {
  regionFromUserPoolId,
  cognitoPasswordAuth,
  getIdentityPoolCredentials,
} from "../src/cognito-auth";
import { prompt } from "../src/cli-prompt";
import {
  loadStarkeepCliConfig,
  resolveAppDir,
  deriveInstallerArns,
  starkeepConfigPath,
} from "../src/app-cli-config";

const flags = process.argv.slice(2);
const nonInteractive = flags.includes("--non-interactive");
const appId = flags.find((f) => !f.startsWith("--"));

if (!appId) {
  console.error("Usage: cli:uninstall-app <appId> [--non-interactive]");
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
    if (newPw !== confirmPw) { console.error("Passwords do not match."); process.exit(1); }
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

let appDir: string;
try {
  appDir = resolveAppDir(config, appId);
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const manifestPath = resolve(appDir, "starkeep.manifest.json");
const manifest = appManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf-8")));

console.log(`\nStarkeep ${appId} cloud uninstall`);
console.log(`  Region : ${region}`);
console.log(`  Stage  : ${stackPrefix}`);
console.log(`  Account: ${accountId}`);
console.log("");

const registryCredentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  sessionToken: process.env.AWS_SESSION_TOKEN!,
};

await uninstallApp({
  appId,
  manifest,
  registryCredentials,
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
  },
});

console.log(`\n${appId} cloud uninstall complete.`);
