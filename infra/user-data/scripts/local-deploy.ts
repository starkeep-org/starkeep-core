#!/usr/bin/env tsx
/**
 * Local deploy/remove wrapper for starkeep user-data infrastructure.
 *
 * Usage (from infra/user-data/):
 *   pnpm run local:deploy   — authenticates with Cognito and runs sst deploy
 *   pnpm run local:remove   — authenticates with Cognito and runs sst remove
 *
 * Reads .starkeep-config.json from the repo root. Generate it from admin-web
 * using the "Download CLI config" button after a successful cloud setup.
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface StarkeepConfig {
  region: string;
  stage: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
}

function loadConfig(): StarkeepConfig {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  // scripts/ is two levels below the repo root (infra/user-data/scripts/)
  const repoRoot = resolve(scriptDir, "..", "..", "..");
  const configPath = resolve(repoRoot, ".starkeep-config.json");

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    console.error(`Error: .starkeep-config.json not found at ${configPath}`);
    console.error(
      "Generate it from admin-web using the \"Download CLI config\" button after cloud setup.",
    );
    process.exit(1);
  }

  try {
    return JSON.parse(raw) as StarkeepConfig;
  } catch {
    console.error("Error: .starkeep-config.json is not valid JSON");
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
      // Write the question directly; suppress echoing by not using rl.question
      process.stdout.write(question);
      process.stdin.setRawMode?.(true);
      let value = "";
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      const onData = (char: string) => {
        if (char === "\n" || char === "\r" || char === "") {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          resolve(value);
        } else if (char === "" || char === "\b") {
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
// Cognito auth (mirrors apps/admin-web/src/lib/cognito-auth.ts)
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

const command = process.argv[2];
if (command !== "deploy" && command !== "remove") {
  console.error("Usage: local-deploy.ts <deploy|remove>");
  process.exit(1);
}

const config = loadConfig();

console.log(`\nStarkeep local ${command}`);
console.log(`  Region : ${config.region}`);
console.log(`  Stage  : ${config.stage}`);
console.log("");

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
let creds: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
try {
  creds = await getSTSCredentials(config, idToken);
} catch (err) {
  console.error(`Failed to get AWS credentials: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
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

process.exit(result.status ?? 1);
