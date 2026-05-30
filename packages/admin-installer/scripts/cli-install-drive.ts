/**
 * Install (or re-install / update) the Starkeep Drive built-in app — the
 * User-Data-Owner identity for all shared-record sync.
 *
 * Mirrors cli-install-cloud-data-server.ts (same Cognito auth + STS flow) but
 * delegates to `installDrive`, a thin `installApp` wrapper. Drive has no
 * compute: the install mints `...-app-starkeep-drive-role` (user-data-owner
 * boundary), runs the per-app DDL (PG role + wildcard-expanded shared-type
 * `access_grants`), and registers the app.
 *
 * Must run AFTER cloud-data-server install, which provisions the foundational
 * infra (DSQL cluster, files bucket, API Gateway) whose coordinates this script
 * reads from ~/.starkeep/config.json.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
import { installDrive } from "../src/builtin-installs";

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
  // Populated by the cloud-data-server install — required here:
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

// Drive's install depends on cloud-data-server's foundational outputs.
if (!config.auroraEndpoint || !config.s3Bucket || !config.apiGatewayId || !config.authorizerId) {
  console.error(
    "Error: cloud-data-server outputs missing from ~/.starkeep/config.json " +
      "(auroraEndpoint, s3Bucket, apiGatewayId, authorizerId). " +
      "Install cloud-data-server first.",
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
const installDdlRoleArn = `arn:aws:iam::${accountId}:role/${stackPrefix}-install-ddl-role`;
const installInfraRoleArn = `arn:aws:iam::${accountId}:role/${stackPrefix}-install-infra-role`;
const artifactsBucket = `${stackPrefix}-artifacts-${accountId}-${region}`;
const apiGatewayExecutionArn =
  config.apiGatewayExecutionArn ?? `arn:aws:execute-api:${region}:${accountId}:${config.apiGatewayId}`;

console.log("\nStarkeep Drive install");
console.log(`  Region : ${region}`);
console.log(`  Prefix : ${stackPrefix}`);
console.log(`  Account: ${accountId}`);
console.log("");

await installDrive({
  stackPrefix,
  region,
  accountId,
  dsqlHostname: config.auroraEndpoint,
  filesBucket: config.s3Bucket,
  artifactsBucket,
  pulumiStateBucket,
  apiGatewayId: config.apiGatewayId,
  apiGatewayExecutionArn,
  authorizerId: config.authorizerId,
  permissionsBoundaryArn,
  foundationalPermissionsBoundaryArn,
  userDataOwnerPermissionsBoundaryArn,
  managerRoleArn,
  installDdlRoleArn,
  installInfraRoleArn,
});

console.log("\nStarkeep Drive install complete.");
