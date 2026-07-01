#!/usr/bin/env tsx
/**
 * Install (or re-install / update) the cloud-data-server built-in app.
 *
 * Replaces the old `sst deploy` flow entirely — there is no SST anymore.
 * cloud-data-server is provisioned via the standard admin-installer pipeline:
 * Manager attaches a wide temp policy, the cloud-data-server app role runs
 * Pulumi up to create DSQL/S3/Lambda/APIGw, the shared-schema DDL is
 * applied, and the temp policy is detached.
 *
 * Reads ~/.starkeep/config.json (or $STARKEEP_DIR/config.json). The
 * admin-web wizard writes this file server-side via /api/config as it advances
 * through setup steps, so it must already exist (with at least userPoolId /
 * userPoolClientId / identityPoolId from the Stack outputs step) before this
 * script runs.
 *
 * Region is NOT stored in the file — it is derived from `userPoolId` (AWS
 * encodes the region into the pool ID, e.g. `us-east-2_Xxxxx`).
 *
 * Usage:
 *   pnpm tsx scripts/cli-install-cloud-data-server.ts
 *   pnpm tsx scripts/cli-install-cloud-data-server.ts --non-interactive
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";

// TEMP (iam-permission-tests POC): if IAM_SDK_TRACE_PATH is set, record
// every AWS SDK call this process makes to that file. Must run before any
// AWS SDK client below is constructed. Imported by relative path so
// admin-installer doesn't take a package-level dep on the POC. Remove
// when the POC graduates or is dropped.
if (process.env.IAM_SDK_TRACE_PATH) {
  const { installSdkTrace } = await import("../../iam-permission-tests/src/sdk-trace");
  installSdkTrace(process.env.IAM_SDK_TRACE_PATH);
}
import { execSync } from "node:child_process";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { installCloudDataServer, isEphemeralInstall } from "../src/builtin-installs";
import { exitOnInstallFailure } from "../src/cli-exit";
import { ensurePulumiPassphrase } from "../src/pulumi-passphrase";
import {
  regionFromUserPoolId,
  cognitoPasswordAuth,
  getIdentityPoolCredentials,
} from "../src/cognito-auth";
import { prompt } from "../src/cli-prompt";

interface StarkeepConfig {
  stackPrefix: string;
  accountId?: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  permissionsBoundaryArn?: string;
  foundationalPermissionsBoundaryArn?: string;
  userDataOwnerPermissionsBoundaryArn?: string;
  managerRoleArn?: string;
  pulumiStateBucket?: string;
  // populated by this script after a successful install:
  apiGatewayUrl?: string;
  apiGatewayId?: string;
  apiGatewayExecutionArn?: string;
  authorizerId?: string;
  s3Bucket?: string;
  auroraEndpoint?: string;
}

const STARKEEP_DIR = starkeepDir();
const CONFIG_PATH = join(STARKEEP_DIR, "config.json");

function loadConfig(): StarkeepConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    console.error(`Error: ~/.starkeep/config.json not found at ${CONFIG_PATH}`);
    console.error("Generate it from admin-web after the bootstrap stack is deployed.");
    process.exit(1);
  }
  try {
    return JSON.parse(raw) as StarkeepConfig;
  } catch {
    console.error("Error: ~/.starkeep/config.json is not valid JSON");
    process.exit(1);
  }
}

const flags = process.argv.slice(2);
const nonInteractive = flags.includes("--non-interactive");

const config = loadConfig();
const region = regionFromUserPoolId(config.userPoolId);
const stackPrefix = config.stackPrefix;

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
    const newPassword = await prompt("New password: ", true);
    const confirmPassword = await prompt("Confirm new password: ", true);
    if (newPassword !== confirmPassword) {
      console.error("Passwords do not match.");
      process.exit(1);
    }
    return newPassword;
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

const managerRoleArn =
  config.managerRoleArn ?? `arn:aws:iam::${accountId}:role/${stackPrefix}-manager-role`;
const permissionsBoundaryArn =
  config.permissionsBoundaryArn
  ?? `arn:aws:iam::${accountId}:policy/${stackPrefix}-app-permissions-boundary`;
const foundationalPermissionsBoundaryArn =
  config.foundationalPermissionsBoundaryArn
  ?? `arn:aws:iam::${accountId}:policy/${stackPrefix}-foundational-permissions-boundary`;
const userDataOwnerPermissionsBoundaryArn =
  config.userDataOwnerPermissionsBoundaryArn
  ?? `arn:aws:iam::${accountId}:policy/${stackPrefix}-user-data-owner-permissions-boundary`;
const pulumiStateBucket =
  config.pulumiStateBucket ?? `${stackPrefix}-pulumi-state-${accountId}-${region}`;

console.log("\nStarkeep cloud-data-server install");
console.log(`  Region : ${region}`);
console.log(`  Prefix : ${stackPrefix}`);
console.log(`  Account: ${accountId}`);
console.log("");

// Rebuild dist.zip before installing. Without this, the install pipeline
// uploads whatever zip was last built locally — and if its hash matches what
// Lambda already has, Pulumi silently skips the code update, shipping stale
// code with no warning. Build is idempotent and fast on incremental runs.
console.log("\nBuilding cloud-data-server bundle…\n");
execSync("pnpm --filter @starkeep/builtin-cloud-data-server build", {
  stdio: "inherit",
});

// Create the Pulumi state passphrase if missing. CloudFormation can't
// create SecureString SSM parameters, so bootstrap leaves this to the
// installer. Idempotent: subsequent installs see the existing value and
// leave it alone — the passphrase must stay stable once any Pulumi state
// exists or every later up/destroy breaks.
console.log("\nChecking Pulumi state passphrase…");
const ensureOutcome = await ensurePulumiPassphrase({
  stackPrefix,
  region,
});
console.log(
  ensureOutcome === "created"
    ? "  Created SecureString with fresh random value."
    : "  Already present; leaving as-is.",
);

console.log("\nInstalling cloud-data-server…\n");
const outputs = await installCloudDataServer({
  stackPrefix,
  region,
  accountId,
  permissionsBoundaryArn,
  foundationalPermissionsBoundaryArn,
  userDataOwnerPermissionsBoundaryArn,
  managerRoleArn,
  pulumiStateBucket,
  userPoolId: config.userPoolId,
  userPoolClientId: config.userPoolClientId,
  // The cloud e2e harness passes --ephemeral to provision disposable infra and
  // skip the production data-protection hardening (versioning/SSE/PAB/deletion-
  // protect). A CLI flag — not an env var — so it can't leak in via the
  // inherited process.env of admin-web's real-install spawn. See
  // isEphemeralInstall.
  ephemeral: isEphemeralInstall(flags),
}).catch(exitOnInstallFailure);

// There is no separate cloud sync identity to install here: shared-record sync
// (including watcher-originated records, origin_app_id = "local-watcher") flows
// through the Starkeep Drive channel under Drive's role.
// Drive is installed as its own pass — `pnpm cli:install-drive` (or the admin
// wizard's second deploy pass) — after this cloud-data-server install completes.

const updated: StarkeepConfig = {
  ...config,
  accountId,
  permissionsBoundaryArn,
  foundationalPermissionsBoundaryArn,
  userDataOwnerPermissionsBoundaryArn,
  managerRoleArn,
  pulumiStateBucket,
  apiGatewayUrl: outputs.apiGatewayUrl,
  apiGatewayId: outputs.apiGatewayId,
  apiGatewayExecutionArn: outputs.apiGatewayExecutionArn,
  authorizerId: outputs.authorizerId,
  s3Bucket: outputs.bucketName,
  auroraEndpoint: outputs.auroraHostname,
};
mkdirSync(STARKEEP_DIR, { recursive: true });
writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), "utf-8");

console.log("\nInstall complete. Updated ~/.starkeep/config.json:");
console.log(`  apiGatewayUrl  : ${outputs.apiGatewayUrl}`);
console.log(`  s3Bucket       : ${outputs.bucketName}`);
console.log(`  auroraEndpoint : ${outputs.auroraHostname}`);
