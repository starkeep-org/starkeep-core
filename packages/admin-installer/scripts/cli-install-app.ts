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
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
import { appManifestSchema } from "@starkeep/admin-manifest";
import { installApp } from "../src/orchestrator";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const INSTALLER_DIR = resolve(SCRIPT_DIR, "..");
// packages/admin-installer -> packages -> starkeep-core -> workspace root
const REPO_ROOT = resolve(INSTALLER_DIR, "..", "..", "..");
// Default app parent dir: the sibling `starkeep-apps/` checkout. Matches the
// default in admin-web's /api/apps/list route.
const DEFAULT_APPS_DIR = resolve(REPO_ROOT, "starkeep-apps");

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
  userDataOwnerPermissionsBoundaryArn?: string;
  managerRoleArn?: string;
  installDdlRoleArn?: string;
  installInfraRoleArn?: string;
  pulumiStateBucket?: string;
  apiGatewayUrl?: string;
  apiGatewayId?: string;
  apiGatewayExecutionArn?: string;
  authorizerId?: string;
  s3Bucket?: string;
  auroraEndpoint?: string;
  appParentDirs?: string[];
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
// App discovery
// ---------------------------------------------------------------------------

// Expand a leading "~" to the user's home dir (mirrors /api/apps/list).
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function appParentDirs(config: StarkeepConfig): string[] {
  const configured = (config.appParentDirs ?? []).filter(
    (d): d is string => typeof d === "string" && d.length > 0,
  );
  const dirs = configured.length > 0 ? configured : [DEFAULT_APPS_DIR];
  return dirs.map(expandHome);
}

/**
 * Find the source dir of the app whose manifest id === appId by scanning the
 * configured app parent dirs (first match wins, earlier dirs take precedence).
 */
function resolveAppDir(config: StarkeepConfig, appId: string): string {
  for (const parentDir of appParentDirs(config)) {
    if (!existsSync(parentDir)) continue;
    for (const name of readdirSync(parentDir)) {
      const appDir = resolve(parentDir, name);
      if (!statSync(appDir).isDirectory()) continue;
      const manifestPath = resolve(appDir, "starkeep.manifest.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { id?: unknown };
        if (manifest.id === appId) return appDir;
      } catch {
        // Skip malformed manifests.
      }
    }
  }
  console.error(
    `Error: no app with manifest id "${appId}" found in ${appParentDirs(config).join(", ")}`,
  );
  process.exit(1);
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
// App bundle build (delegated to the app via the `pnpm bundle` convention)
// ---------------------------------------------------------------------------

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
const installInfraRoleArn =
  config.installInfraRoleArn ?? `arn:aws:iam::${accountId}:role/${stackPrefix}-install-infra-role`;
const apiGatewayExecutionArn =
  config.apiGatewayExecutionArn ??
  (config.apiGatewayId
    ? `arn:aws:execute-api:${region}:${accountId}:${config.apiGatewayId}`
    : "");
const permissionsBoundaryArn =
  config.permissionsBoundaryArn ?? `arn:aws:iam::${accountId}:policy/${stackPrefix}-app-permissions-boundary`;
const foundationalPermissionsBoundaryArn =
  config.foundationalPermissionsBoundaryArn ?? `arn:aws:iam::${accountId}:policy/${stackPrefix}-foundational-permissions-boundary`;
const userDataOwnerPermissionsBoundaryArn =
  config.userDataOwnerPermissionsBoundaryArn ?? `arn:aws:iam::${accountId}:policy/${stackPrefix}-user-data-owner-permissions-boundary`;
const pulumiStateBucket =
  config.pulumiStateBucket ?? `${stackPrefix}-pulumi-state-${accountId}-${region}`;
// Suffixed with account+region to keep the bucket globally unique (the
// bootstrap ArtifactsBucket has the same name shape).
const artifactsBucket = `${stackPrefix}-artifacts-${accountId}-${region}`;

// Locate the app and load its manifest.
const appDir = resolveAppDir(config, appId);
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
  STARKEEP_API_GATEWAY_URL: config.apiGatewayUrl ?? "",
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
    authorizerId: config.authorizerId,
    permissionsBoundaryArn,
    foundationalPermissionsBoundaryArn,
    userDataOwnerPermissionsBoundaryArn,
    managerRoleArn,
    installDdlRoleArn,
    installInfraRoleArn,
  },
});

console.log(`\nInstall complete. ${appId} app available at:`);
console.log(`  ${config.apiGatewayUrl ?? ""}${config.apiGatewayUrl ? `/apps/${appId}/` : "(apiGatewayUrl not in config)"}`);
