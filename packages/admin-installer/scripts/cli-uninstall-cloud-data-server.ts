#!/usr/bin/env tsx
/**
 * Uninstall the cloud-data-server built-in app and all of its AWS resources.
 *
 * Runs `pulumi destroy` on the cloud-data-server Pulumi stack (removes the
 * DSQL cluster, files bucket, billing bucket, Lambda, API Gateway, and CUR
 * report definition), then deletes the cloud-data-server IAM role.
 *
 * Use this before re-running the bootstrap installer when you need a clean
 * slate — for example, after tearing down and redeploying the CloudFormation
 * bootstrap stack.
 *
 * Reads ~/.starkeep/config.json (or $STARKEEP_DIR/config.json). The
 * file must contain at least userPoolId, userPoolClientId, and identityPoolId.
 *
 * Region is NOT stored in the file — it is derived from `userPoolId`.
 *
 * Usage:
 *   pnpm tsx scripts/cli-uninstall-cloud-data-server.ts
 *   pnpm tsx scripts/cli-uninstall-cloud-data-server.ts --non-interactive
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { createInterface } from "node:readline";
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
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { uninstallCloudDataServer, uninstallDrive } from "../src/builtin-installs";
import { exitOnInstallFailure } from "../src/cli-exit";

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
  // Populated by the install script after a successful run. Needed here so
  // we can uninstall Starkeep Drive (a per-app-shaped uninstall, which depends
  // on DSQL/files-bucket existing) before tearing down cloud-data-server's
  // foundational infra.
  apiGatewayId?: string;
  apiGatewayUrl?: string;
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
      `Region is derived from userPoolId, so this prevents the uninstaller from running.`,
    );
  }
  return parts[0];
}

const STARKEEP_DIR = starkeepDir();
const CONFIG_PATH = join(STARKEEP_DIR, "config.json");

function loadConfig(): StarkeepConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    console.error(`Error: ~/.starkeep/config.json not found at ${CONFIG_PATH}`);
    console.error("The config file is required to locate the AWS resources to remove.");
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
        if (char === "\n" || char === "\r" || char === "") {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          resolveFn(value);
        } else if (char === "" || char === "\b") {
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

console.log("\nStarkeep cloud-data-server uninstall");
console.log(`  Region : ${region}`);
console.log(`  Stage  : ${stackPrefix}`);
console.log(`  Account: ${accountId}`);
console.log("");
console.log("WARNING: This will permanently destroy the DSQL cluster, files bucket,");
console.log("         billing bucket, Lambda, API Gateway, and the app IAM role.");
console.log("");

if (!nonInteractive) {
  const confirm = await prompt('Type "yes" to continue: ');
  if (confirm.trim() !== "yes") {
    console.log("Aborted.");
    process.exit(0);
  }
}

// Uninstall Starkeep Drive first (while DSQL/files-bucket still exist), since
// Drive's role + PG role + access_grants are torn down via the foundational
// install-ddl/install-infra roles. Skipped if the previous install never
// recorded its outputs (e.g. it failed before reaching this step), since we
// can't issue the per-app uninstall without the foundational infra coordinates.
if (config.apiGatewayId && config.authorizerId && config.s3Bucket && config.auroraEndpoint && config.apiGatewayExecutionArn) {
  const installDdlRoleArn = `arn:aws:iam::${accountId}:role/${stackPrefix}-install-ddl-role`;
  const installInfraRoleArn = `arn:aws:iam::${accountId}:role/${stackPrefix}-install-infra-role`;
  const artifactsBucket = `${stackPrefix}-artifacts-${accountId}-${region}`;
  try {
    await uninstallDrive(
      {
        stackPrefix,
        region,
        accountId,
        dsqlHostname: config.auroraEndpoint,
        filesBucket: config.s3Bucket,
        artifactsBucket,
        pulumiStateBucket,
        apiGatewayId: config.apiGatewayId,
        apiGatewayExecutionArn: config.apiGatewayExecutionArn,
        apiGatewayUrl: config.apiGatewayUrl ?? "",
        authorizerId: config.authorizerId,
        permissionsBoundaryArn,
        foundationalPermissionsBoundaryArn,
        userDataOwnerPermissionsBoundaryArn,
        managerRoleArn,
        installDdlRoleArn,
        installInfraRoleArn,
      },
      {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        sessionToken: process.env.AWS_SESSION_TOKEN!,
      },
    );
  } catch (err) {
    console.warn(
      `Starkeep Drive uninstall failed: ${err instanceof Error ? err.message : String(err)}\n` +
        "Continuing with cloud-data-server tear-down — manual cleanup of the role may be needed.",
    );
  }
} else {
  console.log("Skipping Starkeep Drive uninstall (config missing post-install outputs).");
}

await uninstallCloudDataServer({
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
}).catch(exitOnInstallFailure);

console.log("\nUninstall complete.");
