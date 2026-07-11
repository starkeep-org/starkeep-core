/**
 * Shared config-load / app-discovery / ARN-derivation for the per-app cloud
 * CLIs (cli-install-app, cli-uninstall-app). Throws instead of exiting so the
 * CLIs own their console output and exit codes.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { configPath } from "@starkeep/app-client";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
// packages/admin-installer/src -> admin-installer -> packages -> starkeep-core -> workspace root
const REPO_ROOT = resolve(SRC_DIR, "..", "..", "..", "..");
// Default app parent dir: the sibling `starkeep-apps/` checkout. Matches the
// default in admin-web's /api/apps/list route.
const DEFAULT_APPS_DIR = resolve(REPO_ROOT, "starkeep-apps");

export interface StarkeepCliConfig {
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
  /**
   * Browser-facing base URL — the CloudFront distribution domain. Falls back to
   * apiGatewayUrl for pre-CloudFront configs. Server-to-server calls keep using
   * apiGatewayUrl directly.
   */
  publicBaseUrl?: string;
  apiGatewayId?: string;
  apiGatewayExecutionArn?: string;
  authorizerId?: string;
  s3Bucket?: string;
  auroraEndpoint?: string;
  appParentDirs?: string[];
}

export const starkeepConfigPath = configPath;

export function loadStarkeepCliConfig(): StarkeepCliConfig {
  const configPath = starkeepConfigPath();
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(
      `config.json not found at ${configPath}. ` +
        "Complete cloud setup (install cloud-data-server) in admin-web first.",
    );
  }
  try {
    return JSON.parse(raw) as StarkeepCliConfig;
  } catch {
    throw new Error(`${configPath} is not valid JSON`);
  }
}

// Expand a leading "~" to the user's home dir (mirrors /api/apps/list).
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function appParentDirs(config: StarkeepCliConfig): string[] {
  const configured = (config.appParentDirs ?? []).filter(
    (d): d is string => typeof d === "string" && d.length > 0,
  );
  const dirs = configured.length > 0 ? configured : [DEFAULT_APPS_DIR];
  return dirs.map(expandHome);
}

/**
 * Find the source dir of the app whose manifest id === appId by scanning the
 * configured app parent dirs (first match wins, earlier dirs take precedence).
 *
 * TODO: This whole filesystem-scan discovery model needs to be replaced —
 * not extended — as part of publishing starkeep-core as a package. The
 * current shape (admin scans configured parent directories on their
 * workstation for any subdir containing a `starkeep.manifest.json`) only
 * makes sense while every app lives in a sibling checkout next to
 * starkeep-core. Once external apps install from their own published
 * packages (npm, a registry, a URL, etc.), "what is the app's source
 * dir?" stops being a meaningful question — the manifest and bundle
 * arrive via the package, not via a directory scan. Don't bolt sibling
 * checkout support onto this; rethink the discovery + resolution model
 * end-to-end when that work happens.
 */
export function resolveAppDir(config: StarkeepCliConfig, appId: string): string {
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
  throw new Error(
    `no app with manifest id "${appId}" found in ${appParentDirs(config).join(", ")}`,
  );
}

export interface DerivedInstallerArns {
  managerRoleArn: string;
  installDdlRoleArn: string;
  installInfraRoleArn: string;
  apiGatewayExecutionArn: string;
  permissionsBoundaryArn: string;
  foundationalPermissionsBoundaryArn: string;
  userDataOwnerPermissionsBoundaryArn: string;
  pulumiStateBucket: string;
  artifactsBucket: string;
}

/** Fill ARNs/buckets the config may omit from the prefix+account+region convention. */
export function deriveInstallerArns(
  config: StarkeepCliConfig,
  accountId: string,
  region: string,
): DerivedInstallerArns {
  const stackPrefix = config.stackPrefix;
  return {
    managerRoleArn:
      config.managerRoleArn ?? `arn:aws:iam::${accountId}:role/${stackPrefix}-manager-role`,
    installDdlRoleArn:
      config.installDdlRoleArn ?? `arn:aws:iam::${accountId}:role/${stackPrefix}-install-ddl-role`,
    installInfraRoleArn:
      config.installInfraRoleArn ??
      `arn:aws:iam::${accountId}:role/${stackPrefix}-install-infra-role`,
    apiGatewayExecutionArn:
      config.apiGatewayExecutionArn ??
      (config.apiGatewayId
        ? `arn:aws:execute-api:${region}:${accountId}:${config.apiGatewayId}`
        : ""),
    permissionsBoundaryArn:
      config.permissionsBoundaryArn ??
      `arn:aws:iam::${accountId}:policy/${stackPrefix}-app-permissions-boundary`,
    foundationalPermissionsBoundaryArn:
      config.foundationalPermissionsBoundaryArn ??
      `arn:aws:iam::${accountId}:policy/${stackPrefix}-foundational-permissions-boundary`,
    userDataOwnerPermissionsBoundaryArn:
      config.userDataOwnerPermissionsBoundaryArn ??
      `arn:aws:iam::${accountId}:policy/${stackPrefix}-user-data-owner-permissions-boundary`,
    pulumiStateBucket:
      config.pulumiStateBucket ?? `${stackPrefix}-pulumi-state-${accountId}-${region}`,
    // Suffixed with account+region to keep the bucket globally unique (the
    // bootstrap ArtifactsBucket has the same name shape).
    artifactsBucket: `${stackPrefix}-artifacts-${accountId}-${region}`,
  };
}
