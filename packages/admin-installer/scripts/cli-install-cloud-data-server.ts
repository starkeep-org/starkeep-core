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
 * Reads ~/.starkeep/config.json (or $STARKEEP_DATA_DIR/config.json). The
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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

// TEMP (iam-permission-tests POC): if IAM_SDK_TRACE_PATH is set, record
// every AWS SDK call this process makes to that file. Must run before any
// AWS SDK client below is constructed. Imported by relative path so
// admin-installer doesn't take a package-level dep on the POC. Remove
// when the POC graduates or is dropped.
if (process.env.IAM_SDK_TRACE_PATH) {
  const { installSdkTrace } = await import("../../iam-permission-tests/src/sdk-trace");
  installSdkTrace(process.env.IAM_SDK_TRACE_PATH);
}
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from "@aws-sdk/client-cognito-identity";
import { execSync } from "node:child_process";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { installCloudDataServer } from "../src/builtin-installs";

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

function regionFromUserPoolId(userPoolId: string): string {
  const parts = userPoolId.split("_");
  if (parts.length < 2 || !parts[0]) {
    throw new Error(
      `userPoolId "${userPoolId}" is not in the expected format <region>_<id>. ` +
      `Region is derived from userPoolId, so this prevents the installer from running.`,
    );
  }
  return parts[0];
}

const STARKEEP_DATA_DIR = process.env.STARKEEP_DATA_DIR ?? join(homedir(), ".starkeep");
const CONFIG_PATH = join(STARKEEP_DATA_DIR, "config.json");

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

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolveFn) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    if (hidden) {
      process.stdout.write(question);
      process.stdin.setRawMode?.(true);
      let value = "";
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      const onData = (char: string) => {
        if (char === "\n" || char === "\r" || char === "") {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          resolveFn(value);
        } else if (char === "" || char === "\b") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      };
      process.stdin.on("data", onData);
    } else {
      rl.question(question, (answer: string) => {
        rl.close();
        resolveFn(answer);
      });
    }
  });
}

async function authenticate(
  config: StarkeepConfig,
  email: string,
  password: string,
): Promise<string> {
  const region = regionFromUserPoolId(config.userPoolId);
  const client = new CognitoIdentityProviderClient({ region });

  const initResponse = await client.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: config.userPoolClientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  );

  if (initResponse.AuthenticationResult?.IdToken) {
    return initResponse.AuthenticationResult.IdToken;
  }

  if (initResponse.ChallengeName === "NEW_PASSWORD_REQUIRED") {
    console.log("\nThis account requires a new password (first login).");
    const newPassword = await prompt("New password: ", true);
    const confirmPassword = await prompt("Confirm new password: ", true);
    if (newPassword !== confirmPassword) {
      console.error("Passwords do not match.");
      process.exit(1);
    }

    const challengeResponse = await client.send(
      new RespondToAuthChallengeCommand({
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        ClientId: config.userPoolClientId,
        Session: initResponse.Session,
        ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
      }),
    );

    const idToken = challengeResponse.AuthenticationResult?.IdToken;
    if (!idToken) throw new Error("No ID token returned after password challenge");
    return idToken;
  }

  throw new Error(`Unexpected Cognito challenge: ${initResponse.ChallengeName}`);
}

async function getSTSCredentials(
  config: StarkeepConfig,
  idToken: string,
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const region = regionFromUserPoolId(config.userPoolId);
  const client = new CognitoIdentityClient({ region });
  const loginKey = `cognito-idp.${region}.amazonaws.com/${config.userPoolId}`;
  const logins = { [loginKey]: idToken };

  const idResponse = await client.send(
    new GetIdCommand({ IdentityPoolId: config.identityPoolId, Logins: logins }),
  );
  if (!idResponse.IdentityId) throw new Error("Failed to get Cognito Identity ID");

  const credsResponse = await client.send(
    new GetCredentialsForIdentityCommand({ IdentityId: idResponse.IdentityId, Logins: logins }),
  );

  const c = credsResponse.Credentials;
  if (!c?.AccessKeyId || !c.SecretKey || !c.SessionToken) {
    throw new Error("Incomplete credentials from Identity Pool");
  }

  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretKey,
    sessionToken: c.SessionToken,
  };
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
  const idToken = await authenticate(config, email, password);

  console.log("Fetching temporary AWS credentials…");
  const creds = await getSTSCredentials(config, idToken);

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
});

// Under Shape A there is no separate cloud sync identity to install here:
// shared-record sync (including watcher-originated records, origin_app_id =
// "local-watcher") flows through the Starkeep Drive channel under Drive's role.
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
mkdirSync(STARKEEP_DATA_DIR, { recursive: true });
writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), "utf-8");

console.log("\nInstall complete. Updated ~/.starkeep/config.json:");
console.log(`  apiGatewayUrl  : ${outputs.apiGatewayUrl}`);
console.log(`  s3Bucket       : ${outputs.bucketName}`);
console.log(`  auroraEndpoint : ${outputs.auroraHostname}`);
