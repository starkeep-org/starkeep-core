/**
 * Shared config-load / app-discovery / ARN-derivation for the per-app cloud
 * CLIs (cli-install-app, cli-uninstall-app). Throws instead of exiting so the
 * CLIs own their console output and exit codes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "@starkeep/app-client";
import { appManifestSchema, type AppManifest } from "@starkeep/admin-manifest";
import type { Registry } from "./registry";
import type { AppSurface, InstallInput, RegistryCredentials } from "./orchestrator";
import {
  resolveBundleCommand,
  resolveInstallCommand,
  type CommandResolution,
  type CommandSource,
} from "./approved-commands";
import { MANIFEST_FILE, scanApps, typedPath } from "./app-discovery";

export interface StarkeepCliConfig {
  stackPrefix: string;
  accountId?: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  /**
   * The client cloud app sessions sign in with, written by the cloud data
   * server install. Each app's Lambdas verify and refresh tokens against it.
   */
  cloudAppsUserPoolClientId?: string;
  /**
   * The client mobile apps sign in with, written by the cloud data server
   * install. An app that ships a mobile build registers its callback on it.
   */
  mobileAppsUserPoolClientId?: string;
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
  /**
   * The platform session authorizer, for handlers declaring `auth: "session"`.
   * Absent in a config written before the authorizer existed; the Pulumi
   * program refuses such an install rather than shipping the app ungated.
   */
  sessionAuthorizerId?: string;
  s3Bucket?: string;
  auroraEndpoint?: string;
  appParentDirs?: string[];
  /**
   * How many Lambda invocations this account can have in flight at once.
   *
   * Not something the installer enforces — it is the number a *client* needs in
   * order to size its own fan-out. The pool is small and shared, one cloud page
   * load already issues a dozen or so invocations, and going over the ceiling
   * produces 503s that read as app bugs rather than as capacity. An app that
   * fans out on the user's behalf should scale that fan-out to this rather than
   * to a literal somebody guessed once.
   *
   * Defaults to 10, which is the unraised account limit.
   */
  lambdaConcurrency?: number;
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

/**
 * Find the source folder of the app whose manifest id is `appId`, with the
 * scan admin-web's app list uses (see `app-discovery.ts`). An empty
 * `appParentDirs` scans nothing.
 */
export function resolveAppDir(config: StarkeepCliConfig, appId: string): string {
  const configured = (config.appParentDirs ?? []).filter(
    (d): d is string => typeof d === "string" && d.length > 0,
  );
  const { apps, problems } = scanApps(configured);
  const found = apps.find((a) => a.appId === appId);
  if (found) return found.appDir;
  const lines = [
    configured.length === 0
      ? `no app with manifest id "${appId}": the config names no app folders (appParentDirs is empty)`
      : `no app with manifest id "${appId}" found in ${configured.join(", ")}`,
    ...problems.map((p) => `  - ${p.dir}: ${p.reason}`),
  ];
  throw new Error(lines.join("\n"));
}

/**
 * Split `--app-dir <path>` out of a CLI's arguments. admin-web passes the
 * folder it resolved, so the CLI does not scan again.
 */
export function takeAppDirFlag(args: string[]): { appDir?: string; rest: string[] } {
  const { value: appDir, rest } = takeFlagValue(args, "--app-dir", "a folder");
  return appDir === undefined ? { rest } : { appDir, rest };
}

/**
 * Take `flag <value>` out of `args`. Throws when the flag has no value;
 * `what` names the value the flag needs, such as "a folder".
 */
export function takeFlagValue(
  args: string[],
  flag: string,
  what: string,
): { value?: string; rest: string[] } {
  const i = args.indexOf(flag);
  if (i === -1) return { rest: args };
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs ${what}`);
  return { value, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

/**
 * The app's source folder: `appDir` when given, after checking that its
 * manifest names `appId`; otherwise the scan's answer.
 */
export function appDirFor(
  config: StarkeepCliConfig,
  appId: string,
  appDir: string | undefined,
): string {
  if (appDir === undefined) return resolveAppDir(config, appId);
  const dir = typedPath(appDir);
  const manifestPath = join(dir, MANIFEST_FILE);
  let id: unknown;
  try {
    id = (JSON.parse(readFileSync(manifestPath, "utf-8")) as { id?: unknown }).id;
  } catch (err) {
    throw new Error(
      `could not read ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (id !== appId) {
    throw new Error(`${manifestPath} names the app "${String(id)}", not "${appId}"`);
  }
  return dir;
}

/**
 * The manifest a cloud uninstall tears down: the one the cloud registry
 * stored at install. A registry row that predates the stored manifest falls
 * back to the app's source folder, which `folder` resolves only when needed.
 */
export async function manifestForUninstall(
  registry: Pick<Registry, "storedManifest">,
  appId: string,
  folder: () => string,
): Promise<{ manifest: AppManifest; from: "registry" | "folder" }> {
  const stored = await registry.storedManifest(appId);
  if (stored) return { manifest: stored, from: "registry" };
  const manifestPath = join(folder(), MANIFEST_FILE);
  return {
    manifest: appManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf-8"))),
    from: "folder",
  };
}

/**
 * The two commands a cloud web app install runs in the app's folder before it
 * deploys: the dependency install, then the bundle build. A bundle command
 * off the approved list stops the install, because there is no bundle to
 * deploy without it. An install command off the list does not run; the
 * caller says what to run by hand, and the bundle step finds out.
 */
export function cloudBuildCommands(
  appDir: string,
  manifest: CommandSource,
):
  | {
      ok: true;
      install: CommandResolution;
      bundle: Extract<CommandResolution, { kind: "run" }>;
    }
  | { ok: false; message: string } {
  const bundle = resolveBundleCommand(appDir, manifest);
  if (bundle.kind !== "run") {
    return {
      ok: false,
      message:
        bundle.kind === "refused"
          ? `The manifest's bundle command \`${bundle.display}\` is not approved: ${bundle.reason} ` +
            `Build the bundle with an approved command, \`<manager> run <script>\`, in ${bundle.cwd}.`
          : bundle.reason,
    };
  }
  return { ok: true, install: resolveInstallCommand(appDir, manifest), bundle };
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

/**
 * The `installApp` input for `cli:install-app`: the app, the surfaces, the
 * bundle and the deployment the config describes.
 *
 * The input names `appDir` as the web app's source, so the install records
 * the folder's `sourceFingerprint`. Admin's cloud list compares that record
 * with the folder's fingerprint now, so an input without it would read as
 * behind after every deploy.
 *
 * Throws for a config without the cloud data server's fields, as
 * `cli:install-app` checks before it gets here.
 */
export function cloudInstallInput(opts: {
  appId: string;
  appDir: string;
  manifest: AppManifest;
  surfaces: readonly AppSurface[];
  zipBuffer?: Buffer;
  config: StarkeepCliConfig;
  region: string;
  accountId: string;
  registryCredentials: RegistryCredentials;
}): InstallInput {
  const { config, region, accountId } = opts;
  const { apiGatewayId, authorizerId, s3Bucket, auroraEndpoint } = config;
  if (!apiGatewayId || !authorizerId || !s3Bucket || !auroraEndpoint) {
    throw new Error(
      "The Starkeep config is missing required fields: apiGatewayId, authorizerId, s3Bucket, auroraEndpoint.",
    );
  }
  return {
    appId: opts.appId,
    manifest: opts.manifest,
    surfaces: opts.surfaces,
    webSourceDir: opts.appDir,
    ...(opts.zipBuffer ? { zipBuffer: opts.zipBuffer } : {}),
    version: opts.manifest.version,
    registryCredentials: opts.registryCredentials,
    config: {
      stackPrefix: config.stackPrefix,
      region,
      accountId,
      dsqlHostname: auroraEndpoint,
      filesBucket: s3Bucket,
      apiGatewayId,
      apiGatewayUrl: config.apiGatewayUrl ?? "",
      authorizerId,
      sessionAuthorizerId: config.sessionAuthorizerId,
      ...deriveInstallerArns(config, accountId, region),
      ...(config.mobileAppsUserPoolClientId
        ? {
            mobileSignIn: {
              userPoolId: config.userPoolId,
              mobileAppsClientId: config.mobileAppsUserPoolClientId,
            },
          }
        : {}),
    },
  };
}
