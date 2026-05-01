#!/usr/bin/env tsx
/**
 * Local deploy/remove wrapper for starkeep user-data infrastructure.
 *
 * Usage (from infra/user-data/):
 *   pnpm run local:deploy   — authenticates with Cognito and runs sst deploy
 *   pnpm run local:remove   — authenticates with Cognito and runs sst remove
 *
 * Reads starkeep-config.json from the repo root. Generate it from admin-web
 * using the "Download CLI config" button after a successful cloud setup.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
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
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface StarkeepConfig {
  region: string;
  stage: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  apiGatewayUrl?: string;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const INFRA_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const CONFIG_PATH = resolve(REPO_ROOT, "starkeep-config.json");
const SST_OUTPUTS_PATH = resolve(INFRA_DIR, ".sst", "outputs.json");

function loadConfig(): StarkeepConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    console.error(`Error: starkeep-config.json not found at ${CONFIG_PATH}`);
    console.error(
      "Generate it from admin-web using the \"Download CLI config\" button after cloud setup.",
    );
    process.exit(1);
  }

  try {
    return JSON.parse(raw) as StarkeepConfig;
  } catch {
    console.error("Error: starkeep-config.json is not valid JSON");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
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
          resolve(value);
        } else if (char === "" || char === "\b") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      };
      process.stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Cognito auth
// ---------------------------------------------------------------------------

async function authenticate(
  config: StarkeepConfig,
  email: string,
  password: string,
): Promise<string> {
  const client = new CognitoIdentityProviderClient({ region: config.region });

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
    console.log(
      "\nThis account requires a new password (first login). Please set a permanent password.",
    );
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
  const client = new CognitoIdentityClient({ region: config.region });
  const loginKey = `cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const flags = process.argv.slice(2);
const command = flags.find((a) => !a.startsWith("--"));
const nonInteractive = flags.includes("--non-interactive");

if (command !== "deploy" && command !== "remove") {
  console.error("Usage: local-deploy.ts <deploy|remove> [--non-interactive]");
  process.exit(1);
}

const config = loadConfig();

console.log(`\nStarkeep local ${command}`);
console.log(`  Region : ${config.region}`);
console.log(`  Stage  : ${config.stage}`);
console.log("");

let creds: { accessKeyId: string; secretAccessKey: string; sessionToken: string };

if (nonInteractive) {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_SESSION_TOKEN) {
    console.error("--non-interactive requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN env vars");
    process.exit(1);
  }
  creds = { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY, sessionToken: AWS_SESSION_TOKEN };
} else {
  const email = await prompt("Email: ");
  const password = await prompt("Password: ", true);

  console.log("\nAuthenticating...");
  let idToken: string;
  try {
    idToken = await authenticate(config, email, password);
  } catch (err) {
    console.error(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log("Getting temporary AWS credentials...");
  try {
    creds = await getSTSCredentials(config, idToken);
  } catch (err) {
    console.error(`Failed to get AWS credentials: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Preflight: verify the deploy-permissions stack exists.
if (command === "deploy") {
  const permissionsStackName = `${config.stage}-deploy-permissions`;
  console.log(`Checking deploy-permissions stack (${permissionsStackName})...`);
  const cfn = new CloudFormationClient({ region: config.region, credentials: creds });
  try {
    const resp = await cfn.send(
      new DescribeStacksCommand({ StackName: permissionsStackName }),
    );
    const phase = resp.Stacks?.[0]?.StackStatus ?? "UNKNOWN";
    if (
      phase !== "CREATE_COMPLETE" &&
      phase !== "UPDATE_COMPLETE" &&
      phase !== "UPDATE_ROLLBACK_COMPLETE"
    ) {
      console.error(
        `Error: deploy-permissions stack is in state ${phase}. Open admin-web -> Deploy permissions to fix.`,
      );
      process.exit(1);
    }
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e.name === "ValidationError" && e.message?.includes("does not exist")) {
      console.error(
        `Error: the deploy-permissions stack "${permissionsStackName}" does not exist.\n` +
          `\n` +
          `The bootstrap stack only grants enough permission to manage the deploy-permissions\n` +
          `stack — the actual SST deploy permissions live there. Create it from admin-web:\n` +
          `\n` +
          `  1. Open admin-web (pnpm --filter admin-web dev)\n` +
          `  2. Navigate to "Deploy permissions" in the sidebar\n` +
          `  3. Click "Create permissions stack"\n` +
          `\n` +
          `Then re-run this command.`,
      );
      process.exit(1);
    }
    console.error(
      `Failed to check deploy-permissions stack: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  console.log("Building workspace packages...");
  const buildResult = spawnSync("pnpm", ["--filter", "@starkeep/storage-adapter", "--filter", "@starkeep/storage-aurora-dsql", "build"], {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
  if (buildResult.status !== 0) {
    console.error("Package build failed. Aborting deploy.");
    process.exit(buildResult.status ?? 1);
  }
}

console.log(`\nRunning: sst ${command} --stage ${config.stage}\n`);

const result = spawnSync(
  "node",
  ["./node_modules/sst/bin/sst.mjs", command, "--stage", config.stage],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      AWS_SESSION_TOKEN: creds.sessionToken,
      AWS_REGION: config.region,
      USER_POOL_ID: config.userPoolId,
      USER_POOL_CLIENT_ID: config.userPoolClientId,
    },
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (command === "deploy") {
  try {
    const outputs = JSON.parse(readFileSync(SST_OUTPUTS_PATH, "utf-8")) as Record<string, string>;
    const existing = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    const updated = { ...existing };
    if (outputs.bucketName) updated.s3Bucket = outputs.bucketName;
    if (outputs.region) updated.s3Region = outputs.region;
    if (outputs.apiGatewayUrl) updated.apiGatewayUrl = outputs.apiGatewayUrl;
    if (outputs.auroraHostname) updated.auroraEndpoint = outputs.auroraHostname;
    writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), "utf-8");
    console.log("\nUpdated starkeep-config.json with deploy outputs:");
    if (outputs.bucketName) console.log(`  s3Bucket       : ${outputs.bucketName}`);
    if (outputs.apiGatewayUrl) console.log(`  apiGatewayUrl  : ${outputs.apiGatewayUrl}`);
    if (outputs.auroraHostname) console.log(`  auroraEndpoint : ${outputs.auroraHostname}`);
  } catch (err) {
    console.warn(
      "Warning: could not update starkeep-config.json with deploy outputs:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

process.exit(0);
