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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { createInterface } from "node:readline";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { uninstallCloudDataServer, uninstallDrive } from "../src/builtin-installs";
import { exitOnInstallFailure } from "../src/cli-exit";
import { useOnlyAwsCredentials } from "../src/aws-env";
import { customDomainInstallInput, type CustomDomainConfigFields } from "../src/custom-domain";
import { adminScriptCredentialsOrExit } from "./admin-credentials";

interface StarkeepConfig extends CustomDomainConfigFields {
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
  /** The distribution's name, which a reinstall must not mistake for its own. */
  cloudfrontDomain?: string;
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

const flags = process.argv.slice(2);
const nonInteractive = flags.includes("--non-interactive");

const config = loadConfig();
const region = regionFromUserPoolId(config.userPoolId);
const stackPrefix = config.stackPrefix;

// Credentials from the environment, as admin-web and the e2e harness pass
// them, else from the admin session `starkeep login --admin` keeps.
useOnlyAwsCredentials(
  await adminScriptCredentialsOrExit(nonInteractive),
  process.env.AWS_REGION ?? region,
);

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
  config.permissionsBoundaryArn ??
  `arn:aws:iam::${accountId}:policy/${stackPrefix}-app-permissions-boundary`;
const foundationalPermissionsBoundaryArn =
  config.foundationalPermissionsBoundaryArn ??
  `arn:aws:iam::${accountId}:policy/${stackPrefix}-foundational-permissions-boundary`;
const userDataOwnerPermissionsBoundaryArn =
  config.userDataOwnerPermissionsBoundaryArn ??
  `arn:aws:iam::${accountId}:policy/${stackPrefix}-user-data-owner-permissions-boundary`;
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
if (
  config.apiGatewayId &&
  config.authorizerId &&
  config.s3Bucket &&
  config.auroraEndpoint &&
  config.apiGatewayExecutionArn
) {
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
  ...customDomainInstallInput(config),
}).catch(exitOnInstallFailure);

// The uninstall deleted the distribution, the custom domain's records and
// every certificate. Nothing of the domain is left for a reinstall to act on,
// and the old distribution's name would mislead its DNS check.
const cleared: StarkeepConfig = { ...loadConfig() };
delete cleared.customDomain;
delete cleared.customDomainStatus;
delete cleared.customDomainAttempted;
delete cleared.customDomainKept;
delete cleared.cloudfrontDomain;
writeFileSync(CONFIG_PATH, JSON.stringify(cleared, null, 2), "utf-8");

console.log("\nUninstall complete.");
