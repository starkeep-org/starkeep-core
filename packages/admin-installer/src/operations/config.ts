/**
 * Reading `config.json` for the cloud operations, and the values every one of
 * them derives from it: the region, the account and the installer's view of
 * the deployment.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { deriveInstallerArns, type StarkeepCliConfig } from "../app-cli-config";
import type { CustomDomainConfigFields } from "../custom-domain";
import type { InstallerConfig } from "../orchestrator";
import type { OperationContext } from "./context";
import { OperationError } from "./errors";

/** Everything the cloud operations read from or write to `config.json`. */
export interface InstallerFileConfig extends StarkeepCliConfig, CustomDomainConfigFields {
  /** The bootstrap's DeviceUserPoolClientId output. */
  deviceUserPoolClientId?: string;
  /** The bootstrap's CognitoDomain output: the managed login page's host name. */
  cognitoDomain?: string;
  /** The name under the star on the sign-in page. */
  deploymentName?: string;
  /** The deployment's settings this machine held with no cloud; seeds SSM once. */
  deploymentSettings?: unknown;
  /** The distribution's own cloudfront.net name. */
  cloudfrontDomain?: string;
}

export function installerConfigPath(starkeepDir: string): string {
  return join(starkeepDir, "config.json");
}

/** The parsed `config.json`, or a `CONFIG_INCOMPLETE` error naming what is wrong. */
export function loadInstallerConfig(starkeepDir: string): InstallerFileConfig {
  const path = installerConfigPath(starkeepDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new OperationError(
      "CONFIG_INCOMPLETE",
      `${path} not found. Set up the cloud first: \`starkeep setup --cloud\`, or Cloud setup in admin-web.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OperationError("CONFIG_INCOMPLETE", `${path} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OperationError("CONFIG_INCOMPLETE", `${path} does not hold a JSON object.`);
  }
  const config = parsed as InstallerFileConfig;
  requireConfigFields(
    starkeepDir,
    config,
    ["stackPrefix", "userPoolId"],
    "Finish the cloud setup's bootstrap step first.",
  );
  return config;
}

/** Write the whole file through a temporary file and a rename, so no reader sees half of it. */
export function writeInstallerConfig(starkeepDir: string, config: InstallerFileConfig): void {
  mkdirSync(starkeepDir, { recursive: true });
  const path = installerConfigPath(starkeepDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmp, path);
}

/** Throw `CONFIG_INCOMPLETE` naming every field of `fields` that `config` lacks. */
export function requireConfigFields<K extends keyof InstallerFileConfig>(
  starkeepDir: string,
  config: InstallerFileConfig,
  fields: readonly K[],
  remedy: string,
): asserts config is InstallerFileConfig & Required<Pick<InstallerFileConfig, K>> {
  const missing = fields.filter((f) => {
    const value = config[f];
    return value === undefined || value === null || value === "";
  });
  if (missing.length > 0) {
    throw new OperationError(
      "CONFIG_INCOMPLETE",
      `${installerConfigPath(starkeepDir)} has no ${missing.join(", ")}. ${remedy}`,
    );
  }
}

/** The fields the cloud data server install writes, which every app operation needs. */
export const CLOUD_DATA_SERVER_FIELDS = [
  "apiGatewayId",
  "authorizerId",
  "s3Bucket",
  "auroraEndpoint",
] as const;

/** The region, which `config.json` never stores: AWS encodes it in the user pool id. */
export function regionOf(config: Pick<InstallerFileConfig, "userPoolId">): string {
  const region = config.userPoolId.split("_")[0];
  if (!region || !config.userPoolId.includes("_")) {
    throw new OperationError(
      "CONFIG_INCOMPLETE",
      `userPoolId "${config.userPoolId}" is not in the form <region>_<id>, so the region is unknown.`,
    );
  }
  return region;
}

/** The deployment's account: `config.json`'s `accountId`, or else the caller's. */
export async function resolveAccountId(
  ctx: OperationContext,
  config: Pick<InstallerFileConfig, "accountId">,
  region: string,
): Promise<string> {
  if (config.accountId) return config.accountId;
  const sts = ctx.overrides?.sts ?? new STSClient({ region });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  if (!identity.Account) {
    throw new OperationError(
      "INSTALL_FAILED",
      "Could not read the AWS account id from the admin's credentials.",
    );
  }
  return identity.Account;
}

/**
 * The installer's view of the deployment, from a config the cloud data server
 * install has completed. The caller checks {@link CLOUD_DATA_SERVER_FIELDS}.
 */
export function deploymentInstallerConfig(
  config: InstallerFileConfig &
    Required<Pick<InstallerFileConfig, (typeof CLOUD_DATA_SERVER_FIELDS)[number]>>,
  accountId: string,
  region: string,
): InstallerConfig {
  return {
    stackPrefix: config.stackPrefix,
    region,
    accountId,
    dsqlHostname: config.auroraEndpoint,
    filesBucket: config.s3Bucket,
    apiGatewayId: config.apiGatewayId,
    apiGatewayUrl: config.apiGatewayUrl ?? "",
    authorizerId: config.authorizerId,
    ...(config.sessionAuthorizerId ? { sessionAuthorizerId: config.sessionAuthorizerId } : {}),
    ...(config.originAuthorizerId ? { originAuthorizerId: config.originAuthorizerId } : {}),
    ...(config.delegatedAuthorizerId
      ? { delegatedAuthorizerId: config.delegatedAuthorizerId }
      : {}),
    ...deriveInstallerArns(config, accountId, region),
    ...(config.mobileAppsUserPoolClientId
      ? {
          mobileSignIn: {
            userPoolId: config.userPoolId,
            mobileAppsClientId: config.mobileAppsUserPoolClientId,
          },
        }
      : {}),
  };
}

/** The banner every cloud operation starts with. */
export function deploymentBanner(
  title: string,
  values: { region: string; stackPrefix: string; accountId: string },
): string {
  return [
    title,
    `  Region : ${values.region}`,
    `  Prefix : ${values.stackPrefix}`,
    `  Account: ${values.accountId}`,
  ].join("\n");
}
