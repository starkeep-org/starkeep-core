#!/usr/bin/env tsx
/**
 * Install (or re-install / update) the photos app in the cloud.
 *
 * Replaces the old SST-based deploy. Builds the Next.js static export,
 * bundles the Lambda handlers, and runs the standard admin-installer
 * pipeline: Manager attaches temp policy, app role runs DSQL DDL + S3
 * setup + Pulumi compute stack, temp policy is detached.
 *
 * Reads ~/.starkeep/config.json. Requires apiGatewayUrl, apiGatewayId,
 * authorizerId, s3Bucket, and auroraEndpoint to be present (written by
 * cli-install-cloud-data-server after the core infrastructure is installed).
 *
 * Usage:
 *   pnpm --filter @starkeep/admin-installer cli:install-photos
 *   pnpm --filter @starkeep/admin-installer cli:install-photos --non-interactive
 */

import {
  execSync,
  spawnSync,
} from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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
import { build } from "esbuild";
import { appManifestSchema } from "@starkeep/admin-manifest";
import { installApp } from "../src/orchestrator";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const INSTALLER_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(INSTALLER_DIR, "..", "..", "..");
const PHOTOS_DIR = resolve(REPO_ROOT, "starkeep-apps", "photos");
const INFRA_DIR = resolve(PHOTOS_DIR, "infra");
const MANIFEST_PATH = resolve(PHOTOS_DIR, "starkeep.manifest.json");

const STARKEEP_DATA_DIR = process.env.STARKEEP_DATA_DIR ?? join(homedir(), ".starkeep");
const CONFIG_PATH = join(STARKEEP_DATA_DIR, "config.json");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface StarkeepConfig {
  stackPrefix: string;
  accountId?: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  permissionsBoundaryArn?: string;
  foundationalPermissionsBoundaryArn?: string;
  managerRoleArn?: string;
  installDdlRoleArn?: string;
  pulumiStateBucket?: string;
  apiGatewayUrl?: string;
  apiGatewayId?: string;
  authorizerId?: string;
  s3Bucket?: string;
  auroraEndpoint?: string;
}

function regionFromUserPoolId(userPoolId: string): string {
  const parts = userPoolId.split("_");
  if (parts.length < 2 || !parts[0]) {
    throw new Error(`userPoolId "${userPoolId}" is not in expected format <region>_<id>`);
  }
  return parts[0];
}

function loadConfig(): StarkeepConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    console.error(`Error: ~/.starkeep/config.json not found at ${CONFIG_PATH}`);
    console.error("Complete cloud setup (install cloud-data-server) in admin-web first.");
    process.exit(1);
  }
  try {
    return JSON.parse(raw) as StarkeepConfig;
  } catch {
    console.error("Error: ~/.starkeep/config.json is not valid JSON");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Cognito auth (mirrors cli-install-cloud-data-server)
// ---------------------------------------------------------------------------

async function authenticate(config: StarkeepConfig, email: string, password: string): Promise<string> {
  const region = regionFromUserPoolId(config.userPoolId);
  const client = new CognitoIdentityProviderClient({ region });
  const init = await client.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: config.userPoolClientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  if (init.AuthenticationResult?.IdToken) return init.AuthenticationResult.IdToken;
  if (init.ChallengeName === "NEW_PASSWORD_REQUIRED") {
    console.log("\nThis account requires a new password (first login).");
    const newPw = await prompt("New password: ", true);
    const confirmPw = await prompt("Confirm new password: ", true);
    if (newPw !== confirmPw) { console.error("Passwords do not match."); process.exit(1); }
    const challenge = await client.send(new RespondToAuthChallengeCommand({
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      ClientId: config.userPoolClientId,
      Session: init.Session,
      ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPw },
    }));
    const idToken = challenge.AuthenticationResult?.IdToken;
    if (!idToken) throw new Error("No ID token returned after password challenge");
    return idToken;
  }
  throw new Error(`Unexpected Cognito challenge: ${init.ChallengeName}`);
}

async function getSTSCredentials(config: StarkeepConfig, idToken: string) {
  const region = regionFromUserPoolId(config.userPoolId);
  const client = new CognitoIdentityClient({ region });
  const loginKey = `cognito-idp.${region}.amazonaws.com/${config.userPoolId}`;
  const logins = { [loginKey]: idToken };
  const idResp = await client.send(new GetIdCommand({ IdentityPoolId: config.identityPoolId, Logins: logins }));
  if (!idResp.IdentityId) throw new Error("Failed to get Cognito Identity ID");
  const credsResp = await client.send(new GetCredentialsForIdentityCommand({ IdentityId: idResp.IdentityId, Logins: logins }));
  const c = credsResp.Credentials;
  if (!c?.AccessKeyId || !c.SecretKey || !c.SessionToken) throw new Error("Incomplete credentials from Identity Pool");
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretKey, sessionToken: c.SessionToken };
}

// ---------------------------------------------------------------------------
// Build + bundle
// ---------------------------------------------------------------------------

async function buildPhotosBundle(): Promise<Buffer> {
  const stagingDir = join(tmpdir(), `starkeep-photos-bundle-${Date.now()}`);
  const distZip = join(stagingDir, "dist.zip");

  try {
    mkdirSync(stagingDir, { recursive: true });

    // 1. Build workspace packages the Lambda handler depends on.
    const WS_PACKAGES = [
      "@starkeep/core",
      "@starkeep/storage-adapter",
      "@starkeep/storage-s3",
      "@starkeep/storage-aurora-dsql",
    ];
    console.log("\nBuilding workspace packages…");
    for (const pkg of WS_PACKAGES) {
      console.log(`  pnpm build: ${pkg}`);
      execSync(`pnpm --filter "${pkg}" build`, { cwd: REPO_ROOT, stdio: "inherit" });
    }

    // 2. Build with OpenNext (runs `open-next build` via pnpm build script).
    console.log("\nBuilding photos app with OpenNext…");
    const buildResult = spawnSync("pnpm", ["build"], {
      cwd: PHOTOS_DIR,
      stdio: "inherit",
      env: { ...process.env, NEXT_PUBLIC_FORCE_REMOTE: "true", NODE_ENV: "production" },
    });
    if (buildResult.status !== 0) {
      console.error("photos OpenNext build failed.");
      process.exit(buildResult.status ?? 1);
    }

    // 3. Copy the OpenNext server function output to the staging root.
    //    The server function is the Next.js Lambda handler (index.handler).
    const serverFnDir = resolve(PHOTOS_DIR, ".open-next", "server-functions", "default");
    if (!existsSync(serverFnDir)) {
      console.error(`OpenNext server-function dir not found at ${serverFnDir}.`);
      process.exit(1);
    }
    console.log("\nCopying OpenNext server function…");
    cpSync(serverFnDir, stagingDir, { recursive: true });

    // 4. Bundle the backend Lambda handler with esbuild. sharp is external —
    //    it needs native binaries installed for the Lambda (linux) platform.
    console.log("\nBundling photos-handler with esbuild…");
    const handlersDir = join(stagingDir, "infra", "src");
    mkdirSync(handlersDir, { recursive: true });

    await build({
      entryPoints: [
        join(INFRA_DIR, "src", "photos-handler.ts"),
      ],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      outdir: handlersDir,
      external: ["sharp"],
      allowOverwrite: true,
    });

    // 5. Install sharp for the Lambda (linux x64) platform.
    console.log("\nInstalling sharp for linux/x64…");
    execSync(
      "npm install --os=linux --cpu=x64 --no-package-lock --no-save sharp",
      { cwd: stagingDir, stdio: "inherit" },
    );

    // 6. Zip everything in staging dir.
    console.log("\nCreating dist.zip…");
    execSync(`zip -r "${distZip}" . -q`, { cwd: stagingDir, stdio: "inherit" });

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

const config = loadConfig();
const region = regionFromUserPoolId(config.userPoolId);
const stackPrefix = config.stackPrefix;

if (!config.apiGatewayId || !config.authorizerId || !config.s3Bucket || !config.auroraEndpoint) {
  console.error(
    "Error: ~/.starkeep/config.json is missing required fields: " +
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
const installDdlRoleArn =
  config.installDdlRoleArn ?? `arn:aws:iam::${accountId}:role/${stackPrefix}-install-ddl-role`;
const permissionsBoundaryArn =
  config.permissionsBoundaryArn ?? `arn:aws:iam::${accountId}:policy/${stackPrefix}-app-permissions-boundary`;
const foundationalPermissionsBoundaryArn =
  config.foundationalPermissionsBoundaryArn ?? `arn:aws:iam::${accountId}:policy/${stackPrefix}-foundational-permissions-boundary`;
const pulumiStateBucket =
  config.pulumiStateBucket ?? `${stackPrefix}-pulumi-state-${accountId}-${region}`;
const artifactsBucket = `${stackPrefix}-artifacts`;

console.log("\nStarkeep photos cloud install");
console.log(`  Region : ${region}`);
console.log(`  Stage  : ${stackPrefix}`);
console.log(`  Account: ${accountId}`);
console.log("");

// Load and validate manifest.
const rawManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const manifest = appManifestSchema.parse(rawManifest);

// Patch the static handler's env with live config values. These are
// placeholder-empty in the manifest file; the CLI fills them at install time.
const staticHandler = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
if (staticHandler) {
  staticHandler.env = {
    STARKEEP_API_GATEWAY_URL: config.apiGatewayUrl ?? "",
    STARKEEP_USER_POOL_ID: config.userPoolId,
    STARKEEP_USER_POOL_CLIENT_ID: config.userPoolClientId,
    STARKEEP_IDENTITY_POOL_ID: config.identityPoolId,
  };
}

// Build and bundle the app.
const zipBuffer = await buildPhotosBundle();
console.log(`\nBundle size: ${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB`);

console.log("\nInstalling photos app…\n");
await installApp({
  appId: "photos",
  manifest,
  zipBuffer,
  version: manifest.version,
  config: {
    stackPrefix,
    region,
    accountId,
    dsqlHostname: config.auroraEndpoint,
    filesBucket: config.s3Bucket,
    artifactsBucket,
    pulumiStateBucket,
    apiGatewayId: config.apiGatewayId,
    authorizerId: config.authorizerId,
    permissionsBoundaryArn,
    foundationalPermissionsBoundaryArn,
    managerRoleArn,
    installDdlRoleArn,
  },
});

console.log(`\nInstall complete. Photos app available at:`);
console.log(`  ${config.apiGatewayUrl ?? ""}${config.apiGatewayUrl ? "/apps/photos/" : "(apiGatewayUrl not in config)"}`);
