#!/usr/bin/env tsx
/**
 * Wipes all user data from Starkeep cloud:
 *   - Deletes every object in the S3 bucket
 *   - Truncates the records, metadata_sync, and migrations tables in Aurora DSQL
 *
 * Requires Cognito sign-in and an explicit typed confirmation before proceeding.
 *
 * Usage (from repo root):
 *   npx tsx scripts/reset-cloud-data.ts
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
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  type ObjectIdentifier,
} from "@aws-sdk/client-s3";
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
  if (!cfg.s3Bucket) {
    console.error("Error: s3Bucket missing from starkeep-config.json");
    process.exit(1);
  }
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
        if (char === "\n" || char === "\r" || char === "") {
          if (char === "") {
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
// S3 cleanup
// ---------------------------------------------------------------------------

async function deleteAllS3Objects(
  s3: S3Client,
  bucket: string,
): Promise<number> {
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
    );

    const objects: ObjectIdentifier[] = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));

    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
      deleted += objects.length;
      process.stdout.write(`\r  Deleted ${deleted} objects...`);
    }

    continuationToken = list.NextContinuationToken;
  } while (continuationToken);

  return deleted;
}

// ---------------------------------------------------------------------------
// DSQL cleanup
// ---------------------------------------------------------------------------

async function truncateDsqlTables(
  endpoint: string,
  region: string,
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string },
): Promise<void> {
  const signer = new DsqlSigner({
    hostname: endpoint,
    region,
    credentials,
  });
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
    // Truncate in dependency-safe order (metadata_sync references records)
    await client.query("DELETE FROM metadata_sync");
    console.log("  Cleared metadata_sync");
    await client.query("DELETE FROM records");
    console.log("  Cleared records");
    await client.query("DELETE FROM migrations");
    console.log("  Cleared migrations");
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const nonInteractive = args.includes("--non-interactive");
const yes = args.includes("--yes");

const config = loadConfig();

console.log("\n⚠  STARKEEP CLOUD DATA RESET ⚠");
console.log("─".repeat(40));
console.log(`  Region   : ${config.region}`);
console.log(`  Stage    : ${config.stage}`);
console.log(`  S3 Bucket: ${config.s3Bucket}`);
console.log(`  DSQL     : ${config.auroraEndpoint}`);
console.log("─".repeat(40));
console.log("\nThis will PERMANENTLY delete all files and records from cloud storage.");

let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };

if (nonInteractive) {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_SESSION_TOKEN) {
    console.error("--non-interactive requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN env vars");
    process.exit(1);
  }
  credentials = { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY, sessionToken: AWS_SESSION_TOKEN };
} else {
  console.log("Sign in with your Starkeep account to proceed.\n");
  const email = await prompt("Email: ");
  const password = await prompt("Password: ", true);

  console.log("\nAuthenticating...");
  let idToken: string;
  try {
    idToken = await authenticate(config, email, password);
    credentials = await getSTSCredentials(config, idToken);
  } catch (err) {
    console.error(`\nAuthentication failed: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log("Authenticated.\n");
}

if (!yes) {
  console.log("This action cannot be undone.");
  const confirmation = await prompt('Type "reset cloud data" to confirm: ');
  if (confirmation !== "reset cloud data") {
    console.log("Aborted — confirmation did not match.");
    process.exit(0);
  }
}

console.log("\nResetting cloud data...\n");

// S3
console.log(`S3: deleting objects in ${config.s3Bucket}`);
const s3 = new S3Client({ region: config.region, credentials });
const deletedCount = await deleteAllS3Objects(s3, config.s3Bucket);
console.log(`\n  Done — ${deletedCount} object(s) deleted.\n`);

// DSQL
console.log("DSQL: truncating tables");
await truncateDsqlTables(config.auroraEndpoint, config.region, credentials);
console.log();

console.log("Done. Cloud data has been wiped.");
