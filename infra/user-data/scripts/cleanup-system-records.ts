#!/usr/bin/env tsx
/**
 * Deletes all records whose type starts with "system:" from the Aurora DSQL
 * records table. These are private data-server state records (e.g. watch file
 * tracking) that were incorrectly stored in the user data layer and should
 * never have been synced to the cloud.
 *
 * Requires Cognito sign-in and an explicit typed confirmation before proceeding.
 *
 * Usage (from infra/user-data/):
 *   npx tsx scripts/cleanup-system-records.ts
 */

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
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface StarkeepConfig {
  region: string;
  stage: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  s3Bucket: string;
  auroraEndpoint: string;
}

function loadConfig(): StarkeepConfig {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..", "..", "..");
  const configPath = resolve(repoRoot, "starkeep-config.json");

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    console.error(`Error: starkeep-config.json not found at ${configPath}`);
    console.error('Generate it from admin-web using the "Download CLI config" button.');
    process.exit(1);
  }

  const cfg = JSON.parse(raw) as StarkeepConfig;
  if (!cfg.auroraEndpoint) {
    console.error("Error: auroraEndpoint missing from starkeep-config.json");
    process.exit(1);
  }
  return cfg;
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
          if (char === "") {
            process.stdin.setRawMode?.(false);
            process.stdout.write("\n");
            process.exit(0);
          }
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

async function authenticate(config: StarkeepConfig, email: string, password: string): Promise<string> {
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
    console.log("\nNew password required. Please set a permanent password.");
    const newPassword = await prompt("New password: ", true);
    const confirm = await prompt("Confirm new password: ", true);
    if (newPassword !== confirm) {
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
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretKey, sessionToken: c.SessionToken };
}

// ---------------------------------------------------------------------------
// DSQL cleanup
// ---------------------------------------------------------------------------

async function deleteSystemRecords(
  endpoint: string,
  region: string,
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string },
): Promise<number> {
  const signer = new DsqlSigner({ hostname: endpoint, region, credentials });
  const token = await signer.getDbConnectAdminAuthToken();

  const client = new pg.Client({
    host: endpoint,
    port: 5432,
    database: "postgres",
    user: "admin",
    password: token,
    ssl: { rejectUnauthorized: true },
  });

  await client.connect();
  try {
    const countResult = await client.query("SELECT COUNT(*) AS n FROM records WHERE type LIKE 'system:%'");
    const count = parseInt(countResult.rows[0].n, 10);

    if (count === 0) {
      console.log("  No system: records found — nothing to delete.");
      return 0;
    }

    console.log(`  Found ${count} record(s) with type starting with "system:".`);
    const confirmation = await prompt(`Type "delete system records" to confirm deletion of ${count} record(s): `);
    if (confirmation !== "delete system records") {
      console.log("Aborted — confirmation did not match.");
      process.exit(0);
    }

    const deleteResult = await client.query("DELETE FROM records WHERE type LIKE 'system:%'");
    return deleteResult.rowCount ?? count;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const config = loadConfig();

console.log("\nSTARKEEP SYSTEM RECORD CLEANUP");
console.log("─".repeat(40));
console.log(`  Region : ${config.region}`);
console.log(`  Stage  : ${config.stage}`);
console.log(`  DSQL   : ${config.auroraEndpoint}`);
console.log("─".repeat(40));
console.log('\nThis will delete all records whose type starts with "system:" from Aurora DSQL.');
console.log("No S3 objects or metadata_sync rows are affected.\n");

const email = await prompt("Email: ");
const password = await prompt("Password: ", true);

console.log("\nAuthenticating...");
let idToken: string;
let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
try {
  idToken = await authenticate(config, email, password);
  credentials = await getSTSCredentials(config, idToken);
} catch (err) {
  console.error(`\nAuthentication failed: ${(err as Error).message}`);
  process.exit(1);
}
console.log("Authenticated.\n");

console.log("Checking for system: records...");
const deleted = await deleteSystemRecords(config.auroraEndpoint, config.region, credentials);
if (deleted > 0) {
  console.log(`\nDone — ${deleted} system: record(s) deleted.`);
}
