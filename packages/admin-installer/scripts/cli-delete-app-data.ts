#!/usr/bin/env tsx
/**
 * Delete the data a cloud uninstall kept for one app: the tables in its
 * `app_<appId>` schema, its Postgres role and its files under `apps/<appId>/`
 * in the files bucket.
 *
 * Uninstall keeps an app's data, so a reinstall gets it back. This is the
 * separate, explicit action that deletes it. It refuses an app that is still
 * installed in the cloud, and it touches only the cloud's copy: every device
 * keeps its own. It prints what it would delete, by counts, and then asks the
 * operator to type the app id.
 *
 * Usage:
 *   pnpm --filter @starkeep/admin-installer cli:delete-app-data <appId>
 *   pnpm --filter @starkeep/admin-installer cli:delete-app-data <appId> --non-interactive --confirm <appId>
 *
 * `--non-interactive` reads AWS credentials from the environment, as the other
 * cloud CLIs do. It never deletes on its own: a non-interactive run also needs
 * `--confirm` naming the same app id.
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { deleteAppDataCloud } from "../src/cloud-app-data";
import { createDsqlRegistry } from "../src/registry";
import {
  regionFromUserPoolId,
  cognitoPasswordAuth,
  getIdentityPoolCredentials,
} from "../src/cognito-auth";
import { prompt } from "../src/cli-prompt";
import { useOnlyAwsCredentials } from "../src/aws-env";
import {
  loadStarkeepCliConfig,
  deriveInstallerArns,
  starkeepConfigPath,
  takeFlagValue,
} from "../src/app-cli-config";

let flags: string[];
let confirmFlag: string | undefined;
try {
  ({ value: confirmFlag, rest: flags } = takeFlagValue(
    process.argv.slice(2),
    "--confirm",
    "the app id",
  ));
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const nonInteractive = flags.includes("--non-interactive");
const appId = flags.find((f) => !f.startsWith("--"));

if (!appId) {
  console.error("Usage: cli:delete-app-data <appId> [--non-interactive --confirm <appId>]");
  process.exit(1);
}
if (nonInteractive && confirmFlag !== appId) {
  console.error(
    `Error: --non-interactive deletes data only with --confirm ${appId}. Nothing changed.`,
  );
  process.exit(1);
}

let config: ReturnType<typeof loadStarkeepCliConfig>;
try {
  config = loadStarkeepCliConfig();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const region = regionFromUserPoolId(config.userPoolId);
const stackPrefix = config.stackPrefix;

if (!config.apiGatewayId || !config.authorizerId || !config.s3Bucket || !config.auroraEndpoint) {
  console.error(
    `Error: ${starkeepConfigPath()} is missing required fields: ` +
      "apiGatewayId, authorizerId, s3Bucket, auroraEndpoint.\n" +
      "There is no cloud-data-server install to delete app data from.",
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
  useOnlyAwsCredentials(
    {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      sessionToken: AWS_SESSION_TOKEN,
    },
    process.env.AWS_REGION ?? region,
  );
} else {
  const email = await prompt("Email: ");
  const password = await prompt("Password: ", true);
  console.log("\nAuthenticating with Cognito…");
  const idToken = await cognitoPasswordAuth(config, email, password, async () => {
    console.log("\nThis account requires a new password (first login).");
    const newPw = await prompt("New password: ", true);
    const confirmPw = await prompt("Confirm new password: ", true);
    if (newPw !== confirmPw) {
      console.error("Passwords do not match.");
      process.exit(1);
    }
    return newPw;
  });
  console.log("Fetching temporary AWS credentials…");
  const creds = await getIdentityPoolCredentials(config, idToken);
  useOnlyAwsCredentials(creds, region);
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

const arns = deriveInstallerArns(config, accountId, region);
const registryCredentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  sessionToken: process.env.AWS_SESSION_TOKEN!,
};
const registry = createDsqlRegistry({
  hostname: config.auroraEndpoint,
  region,
  stackPrefix,
  credentials: registryCredentials,
});

console.log(`\nStarkeep ${appId}: delete the app data the cloud kept`);
console.log(`  Region : ${region}`);
console.log(`  Stage  : ${stackPrefix}`);
console.log(`  Account: ${accountId}`);
console.log("");

let outcome: "deleted" | "cancelled";
try {
  outcome = await deleteAppDataCloud({
    appId,
    registry,
    config: {
      stackPrefix,
      region,
      accountId,
      dsqlHostname: config.auroraEndpoint,
      filesBucket: config.s3Bucket,
      artifactsBucket: arns.artifactsBucket,
      pulumiStateBucket: arns.pulumiStateBucket,
      apiGatewayId: config.apiGatewayId,
      apiGatewayExecutionArn: arns.apiGatewayExecutionArn,
      apiGatewayUrl: config.apiGatewayUrl ?? "",
      authorizerId: config.authorizerId,
      permissionsBoundaryArn: arns.permissionsBoundaryArn,
      foundationalPermissionsBoundaryArn: arns.foundationalPermissionsBoundaryArn,
      userDataOwnerPermissionsBoundaryArn: arns.userDataOwnerPermissionsBoundaryArn,
      managerRoleArn: arns.managerRoleArn,
      installDdlRoleArn: arns.installDdlRoleArn,
      installInfraRoleArn: arns.installInfraRoleArn,
    },
    confirm: async (counts) => {
      const rows = `${counts.totalRows.toLocaleString()} row${counts.totalRows === 1 ? "" : "s"}`;
      console.log(`The cloud keeps ${counts.retained.name}'s data from an uninstall:`);
      for (const t of counts.tables) {
        console.log(`  ${t.name}: ${t.rowCount.toLocaleString()} rows`);
      }
      if (counts.files) {
        console.log(
          `  files: ${counts.files.count.toLocaleString()} (${counts.files.totalBytes.toLocaleString()} bytes)`,
        );
      }
      console.log(
        `\nDeleting it removes ${rows}${counts.files ? " and the files" : ""} from the cloud, ` +
          "for every account in this deployment. Records the app shared with other apps stay.",
      );
      console.log(
        "Devices that keep this app's data do not upload it again after the deletion: " +
          "each device keeps its own copy, and the cloud's copy stays partial until STA-96 " +
          "is fixed.\n",
      );
      if (nonInteractive) return true;
      const answer = await prompt(`Type ${appId} to delete its cloud data: `);
      return answer.trim() === appId;
    },
  });
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  await registry.close();
}

if (outcome === "cancelled") {
  console.log("Deletion cancelled. Nothing changed.");
  process.exit(1);
}
console.log(`\n${appId}'s cloud data deleted.`);
