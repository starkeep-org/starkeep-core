#!/usr/bin/env tsx
/**
 * Install (or re-install / update) a Starkeep app in the cloud.
 *
 * Generic across cloud apps: this script owns the platform-side orchestration
 * (Cognito auth, config load, ARN derivation, manifest validation, the
 * installApp state machine). The app-specific bundle build lives in the app
 * itself — this script invokes it via the convention:
 *
 *   pnpm bundle   (run in the app's source dir)
 *     env in:  STARKEEP_APP_BASE_PATH = /apps/<appId>
 *              STARKEEP_BUNDLE_OUT    = <abs path to write dist.zip>
 *     out:     app writes dist.zip to STARKEEP_BUNDLE_OUT
 *
 * The app is located by scanning the configured app parent dirs (same
 * discovery as admin-web's /api/apps/list) for the manifest whose id matches.
 *
 * Reads ~/.starkeep/config.json. Requires apiGatewayUrl, apiGatewayId,
 * authorizerId, s3Bucket, and auroraEndpoint to be present (written by
 * cli-install-cloud-data-server after the core infrastructure is installed).
 *
 * Usage:
 *   pnpm --filter @starkeep/admin-installer cli:install-app <appId>
 *   pnpm --filter @starkeep/admin-installer cli:install-app <appId> --non-interactive
 */

// TEMP (iam-permission-tests POC): if IAM_SDK_TRACE_PATH is set, record
// every AWS SDK call this process makes to that file. Must run before any
// AWS SDK client below is constructed. Imported by relative path so
// admin-installer doesn't take a package-level dep on the POC. Remove
// when the POC graduates or is dropped.
if (process.env.IAM_SDK_TRACE_PATH) {
  const { installSdkTrace } = await import("../../iam-permission-tests/src/sdk-trace");
  installSdkTrace(process.env.IAM_SDK_TRACE_PATH);
}
// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { appManifestSchema } from "@starkeep/admin-manifest";
import { installApp } from "../src/orchestrator";
import { exitOnInstallFailure } from "../src/cli-exit";
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

function buildAppBundle(appDir: string, appBasePath: string): Buffer {
  const stagingDir = join(tmpdir(), `starkeep-app-bundle-${Date.now()}`);
  const distZip = join(stagingDir, "dist.zip");
  try {
    mkdirSync(stagingDir, { recursive: true });
    console.log(`\nBuilding app bundle (pnpm bundle in ${appDir})…`);
    const result = spawnSync("pnpm", ["bundle"], {
      cwd: appDir,
      stdio: "inherit",
      env: {
        ...process.env,
        STARKEEP_APP_BASE_PATH: appBasePath,
        STARKEEP_BUNDLE_OUT: distZip,
      },
    });
    if (result.status !== 0) {
      console.error(
        `App bundle build failed (pnpm bundle exited ${result.status}). ` +
        `Cloud-installable apps must provide a "bundle" script that writes ` +
        `dist.zip to STARKEEP_BUNDLE_OUT.`,
      );
      process.exit(result.status ?? 1);
    }
    if (!existsSync(distZip)) {
      console.error(`App bundle build did not produce a dist.zip at ${distZip}.`);
      process.exit(1);
    }
    return readFileSync(distZip);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const flags = process.argv.slice(2);
const nonInteractive = flags.includes("--non-interactive");
const appId = flags.find((f) => !f.startsWith("--"));

if (!appId) {
  console.error("Usage: cli:install-app <appId> [--non-interactive]");
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
    "Install the cloud-data-server first.",
  );
  process.exit(1);
}

if (nonInteractive) {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_SESSION_TOKEN) {
    console.error("--non-interactive requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN env vars");
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

// Locate the app and load its manifest.
let appDir: string;
try {
  appDir = resolveAppDir(config, appId);
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const manifestPath = resolve(appDir, "starkeep.manifest.json");
const rawManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const manifest = appManifestSchema.parse(rawManifest);

console.log(`\nStarkeep ${appId} cloud install`);
console.log(`  Region : ${region}`);
console.log(`  Stage  : ${stackPrefix}`);
console.log(`  Account: ${accountId}`);
console.log(`  App dir: ${appDir}`);
console.log("");

// Patch handler env with live platform config. Handlers declare the keys they
// want by listing them (placeholder-empty) in the manifest; the installer fills
// any empty value whose key it recognizes. App-agnostic: no handler-name or
// app-name coupling.
const platformEnv: Record<string, string> = {
  // Browser-facing base URL points at the CloudFront distribution (publicBaseUrl)
  // so the whole browser fan-out — runtime-config → SPA data-client / cloud-config
  // / admin-web, all of which derive their origin from this env value — routes
  // through the edge cache. Server-to-server HMAC calls keep using apiGatewayUrl
  // directly (STARKEEP_CLOUD_DATA_BASE in pulumi-program.ts). Falls back to the
  // raw gateway URL for pre-CloudFront configs.
  STARKEEP_API_GATEWAY_URL: config.publicBaseUrl ?? config.apiGatewayUrl ?? "",
  STARKEEP_USER_POOL_ID: config.userPoolId,
  STARKEEP_USER_POOL_CLIENT_ID: config.userPoolClientId,
  STARKEEP_IDENTITY_POOL_ID: config.identityPoolId,
};
for (const handler of manifest.infraRequirements.compute.handlers) {
  for (const key of Object.keys(handler.env)) {
    if (handler.env[key] === "" && key in platformEnv) {
      handler.env[key] = platformEnv[key];
    }
  }
}

// Build the app bundle via the app's own `pnpm bundle` script. The base path
// /apps/<appId> is the platform's routing convention (the shared API Gateway
// forwards requests under it; see pulumi-program).
const zipBuffer = buildAppBundle(appDir, `/apps/${appId}`);
console.log(`\nBundle size: ${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB`);

console.log(`\nInstalling ${appId} app…\n`);
// Registry writes authenticate to DSQL as the admin-app IAM role (mapped to
// `${stackPrefix}_installer` PG role at schema-init time). The ambient
// AWS_* env vars are that role's session credentials, set above either
// from getSTSCredentials (interactive) or by the caller (--non-interactive).
const registryCredentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  sessionToken: process.env.AWS_SESSION_TOKEN!,
};

await installApp({
  appId,
  manifest,
  zipBuffer,
  version: manifest.version,
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
}).catch(exitOnInstallFailure);

console.log(`\nInstall complete. ${appId} app available at:`);
console.log(`  ${config.apiGatewayUrl ?? ""}${config.apiGatewayUrl ? `/apps/${appId}/` : "(apiGatewayUrl not in config)"}`);
