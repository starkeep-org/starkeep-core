/**
 * Install, reinstall or update an app in the cloud.
 *
 * Every install creates the app's data side: its role, schema, tables, grants
 * and namespace. The `web` surface adds the cloud web app (its compute), and
 * `mobile` adds the mobile app (its Android identity and sign-in callback).
 * Without `surfaces`, the install adds every surface the manifest offers. A
 * surface already installed stays installed.
 *
 * For a web app, the operation first installs the app's dependencies, then
 * runs its bundle command: the manifest's `installDependencies` and `bundle`,
 * or the commands its lockfile implies (`<manager> run bundle`), each checked
 * against the approved list in `approved-commands.ts`. The bundle command gets:
 *
 *   STARKEEP_APP_BASE_PATH   = /apps/<appId>
 *   STARKEEP_BUNDLE_OUT      = the path to write dist.zip to
 *   STARKEEP_PUBLIC_BASE_URL = the deployment's browser-facing base URL, when known
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateManifest, type AppManifest } from "@starkeep/admin-manifest";
import { formatAnonymousRouteReport } from "../anonymous-route-report";
import { appDirFor, cloudBuildCommands, cloudInstallInput } from "../app-cli-config";
import { unattendedArgs, type CommandResolution } from "../approved-commands";
import { withoutAwsVariables } from "../aws-env";
import { manifestDigest } from "../manifest-approval";
import { installApp, manifestSurfaces, type AppSurface } from "../orchestrator";
import { formatProbeReport, probeAnonymousSurface } from "../post-install-probe";
import { protocolRefusal } from "../protocol-check";
import { platformEnvValues } from "../platform-env";
import type { Operation, OperationContext } from "./context";
import {
  CLOUD_DATA_SERVER_FIELDS,
  deploymentBanner,
  installerConfigPath,
  loadInstallerConfig,
  regionOf,
  requireConfigFields,
  resolveAccountId,
  type InstallerFileConfig,
} from "./config";
import type { Emit } from "./events";
import { OperationError } from "./errors";
import { runCommand } from "./steps";
import { createDsqlRegistry } from "../registry";
import type { SourceCommit } from "../deployed-source";
import { assertNotBackward, comparisonNote, compareWithDeployed } from "./deploy-guard";

export interface InstallCloudAppInput {
  appId: string;
  /** The app's source folder. Without it, the discovery folders are scanned for the id. */
  appDir?: string;
  /** The surfaces to add on top of the data side. Omitted, every surface the manifest offers. */
  surfaces?: AppSurface[];
  /**
   * The digest of the manifest the person approved (`manifest-approval.ts`).
   * A folder whose manifest no longer matches deploys nothing.
   */
  manifestDigest?: string;
  /**
   * Deploy even when the cloud runs patches the folder's checkout lacks
   * (`deploy-guard.ts`). The CLI's `--force` sets it.
   */
  allowBackward?: boolean;
}

export interface InstallCloudAppResult {
  appId: string;
  surfaces: AppSurface[];
  /** Where the web app answers, when the install added one. */
  url?: string;
}

/** The protocol version the cloud data server reports, or null for one that reports none. */
async function cloudProtocolVersion(
  ctx: OperationContext,
  dir: string,
  apiGatewayUrl: string | undefined,
): Promise<string | null> {
  if (!apiGatewayUrl) {
    throw new OperationError(
      "CONFIG_INCOMPLETE",
      `${installerConfigPath(dir)} has no apiGatewayUrl. Install the cloud data server first.`,
    );
  }
  const doFetch = ctx.overrides?.fetch ?? fetch;
  let body: { protocolVersion?: unknown };
  try {
    const res = await doFetch(`${apiGatewayUrl}/health`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    body = (await res.json()) as { protocolVersion?: unknown };
  } catch (err) {
    throw new OperationError(
      "INSTALL_FAILED",
      `Could not read the cloud data server's protocol version from ${apiGatewayUrl}/health: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  return typeof body.protocolVersion === "string" ? body.protocolVersion : null;
}

async function installDependencies(
  ctx: OperationContext,
  install: CommandResolution,
  emit: Emit,
): Promise<void> {
  if (install.kind === "skip") return;
  if (install.kind === "refused") {
    emit({
      type: "progress",
      message:
        `Warning: not running the manifest's install command \`${install.display}\`: ${install.reason} ` +
        `Run it yourself in ${install.cwd} if the bundle build needs it.`,
    });
    return;
  }
  emit({
    type: "progress",
    message: `Installing dependencies (${install.display} in ${install.cwd})…`,
  });
  const run = ctx.overrides?.runCommand ?? runCommand;
  const code = await run(
    {
      command: install.command,
      args: unattendedArgs(install.command, install.args),
      cwd: install.cwd,
      // Hygiene, not isolation: see the module comment in aws-env.ts.
      env: withoutAwsVariables(process.env),
    },
    emit,
  );
  if (code !== 0) {
    throw new OperationError(
      "BUNDLE_FAILED",
      `Dependency install failed (${install.display} exited ${code ?? "without a code"}).`,
    );
  }
}

async function buildBundle(
  ctx: OperationContext,
  bundle: Extract<CommandResolution, { kind: "run" }>,
  appBasePath: string,
  publicBaseUrl: string | undefined,
  emit: Emit,
): Promise<Buffer> {
  const stagingDir = join(tmpdir(), `starkeep-app-bundle-${Date.now()}-${process.pid}`);
  const distZip = join(stagingDir, "dist.zip");
  try {
    mkdirSync(stagingDir, { recursive: true });
    emit({
      type: "progress",
      message: `Building the app bundle (${bundle.display} in ${bundle.cwd})…`,
    });
    const run = ctx.overrides?.runCommand ?? runCommand;
    const code = await run(
      {
        command: bundle.command,
        args: bundle.args,
        cwd: bundle.cwd,
        env: {
          ...withoutAwsVariables(process.env),
          STARKEEP_APP_BASE_PATH: appBasePath,
          STARKEEP_BUNDLE_OUT: distZip,
          // A file the build writes into its static assets is served from the
          // assets bucket, never by the app's Lambda, so a file that must name
          // the deployment's own URL needs it here.
          ...(publicBaseUrl ? { STARKEEP_PUBLIC_BASE_URL: publicBaseUrl } : {}),
        },
      },
      emit,
    );
    if (code !== 0) {
      throw new OperationError(
        "BUNDLE_FAILED",
        `App bundle build failed (${bundle.display} exited ${code ?? "without a code"}). ` +
          `Cloud-installable apps must provide a "bundle" script that writes ` +
          `dist.zip to STARKEEP_BUNDLE_OUT.`,
      );
    }
    if (!existsSync(distZip)) {
      throw new OperationError(
        "BUNDLE_FAILED",
        `App bundle build did not produce a dist.zip at ${distZip}.`,
      );
    }
    return readFileSync(distZip);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Fill each handler's empty platform variables with the deployment's values.
 * Handlers declare the keys they want by listing them empty in the manifest.
 */
function fillPlatformEnv(
  manifest: AppManifest,
  config: InstallerFileConfig,
  cloudAppsUserPoolClientId: string,
): void {
  // Readers compare the recorded manifest with these same values
  // (`platform-env.ts`), so one function computes both.
  const platformEnv = platformEnvValues({ ...config, cloudAppsUserPoolClientId });
  for (const handler of manifest.infraRequirements.compute.handlers) {
    for (const key of Object.keys(handler.env)) {
      if (handler.env[key] === "" && key in platformEnv) {
        handler.env[key] = platformEnv[key as keyof typeof platformEnv];
      }
    }
  }
}

/** The commit the app's last cloud install recorded. */
async function deployedAppSource(
  ctx: OperationContext,
  appId: string,
  registryOptions: Parameters<typeof createDsqlRegistry>[0],
): Promise<SourceCommit | null> {
  if (ctx.overrides?.deployedAppSource) return ctx.overrides.deployedAppSource(appId);
  const create = ctx.overrides?.createDsqlRegistry ?? createDsqlRegistry;
  const registry = create(registryOptions);
  try {
    return await registry.deployedSource(appId);
  } finally {
    await registry.close();
  }
}

export const installCloudAppOp: Operation<InstallCloudAppInput, InstallCloudAppResult> = async (
  ctx,
  input,
  emit,
) => {
  const { appId } = input;
  const dir = ctx.starkeepDir;
  if (!appId) throw new OperationError("INVALID_INPUT", "Name the app to install.");
  for (const s of input.surfaces ?? []) {
    if (s !== "web" && s !== "mobile") {
      throw new OperationError(
        "INVALID_INPUT",
        `Unknown surface "${String(s)}": use web or mobile.`,
      );
    }
  }
  const config = loadInstallerConfig(dir);
  requireConfigFields(
    dir,
    config,
    CLOUD_DATA_SERVER_FIELDS,
    "Install the cloud data server first.",
  );
  const region = regionOf(config);

  // Everything up to the deploy reads only this computer and the cloud's
  // public health check, so a refusal costs no sign-in.
  let appDir: string;
  try {
    appDir = appDirFor(config, appId, input.appDir);
  } catch (err) {
    throw new OperationError("MANIFEST_INVALID", err instanceof Error ? err.message : String(err));
  }
  const manifestPath = resolve(appDir, "starkeep.manifest.json");
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    throw new OperationError(
      "MANIFEST_INVALID",
      `Could not read ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // The protocol check runs before validation and before any build: an app
  // written for a newer platform usually fails the older validator too, and
  // the version mismatch is the message that says to redeploy.
  const protocolProblem = protocolRefusal({
    appId,
    rawManifest,
    platformVersion: await cloudProtocolVersion(ctx, dir, config.apiGatewayUrl),
    target: "cloud",
  });
  if (protocolProblem) throw new OperationError("PROTOCOL_MISMATCH", protocolProblem);
  // Full validation, not a bare schema parse: the cross-field rules hold the
  // "an anonymous catch-all must declare its publicPaths" gate.
  const validation = validateManifest(rawManifest);
  for (const warning of validation.warnings)
    emit({ type: "progress", message: `Warning: ${warning}` });
  if (!validation.manifest) {
    throw new OperationError(
      "MANIFEST_INVALID",
      `${manifestPath} is not a valid app manifest:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
  const manifest = validation.manifest;
  if (input.manifestDigest !== undefined && manifestDigest(manifest) !== input.manifestDigest) {
    throw new OperationError(
      "MANIFEST_NOT_APPROVED",
      `${manifestPath} changed after the manifest was approved. Review the new manifest and deploy again.`,
    );
  }

  const offered = manifestSurfaces(manifest);
  const surfaces = input.surfaces ?? offered;
  for (const surface of surfaces) {
    if (!offered.includes(surface)) {
      throw new OperationError(
        "INVALID_INPUT",
        surface === "web"
          ? `${appId}'s manifest declares no compute, so it has no web app.`
          : `${appId}'s manifest declares no mobile build (mobile.android).`,
      );
    }
  }
  const installsWeb = surfaces.includes("web");
  // Checked before anything deploys: a web app without an approved bundle
  // command has nothing to deploy.
  const build = installsWeb ? cloudBuildCommands(appDir, manifest) : null;
  if (build && !build.ok) throw new OperationError("COMMAND_NOT_APPROVED", build.message);
  if (installsWeb && !config.cloudAppsUserPoolClientId) {
    throw new OperationError(
      "CONFIG_INCOMPLETE",
      `${installerConfigPath(dir)} has no cloudAppsUserPoolClientId. ` +
        "Reinstall the cloud data server first; it creates the client cloud apps sign in with.",
    );
  }
  if (surfaces.includes("mobile") && !config.mobileAppsUserPoolClientId) {
    throw new OperationError(
      "CONFIG_INCOMPLETE",
      `${installerConfigPath(dir)} has no mobileAppsUserPoolClientId. ` +
        "Reinstall the cloud data server first; it creates the client mobile apps sign in with.",
    );
  }

  const credentials = await ctx.adminLane(region);
  const accountId = await resolveAccountId(ctx, config, region);
  emit({
    type: "progress",
    message: [
      deploymentBanner(`Starkeep ${appId} cloud install`, {
        region,
        stackPrefix: config.stackPrefix,
        accountId,
      }),
      `  App dir: ${appDir}`,
      `  Adds   : ${surfaces.length > 0 ? surfaces.join(", ") : "the data side only"}`,
    ].join("\n"),
  });

  // Before anything deploys: does the cloud run patches this folder lacks?
  const deployed = await deployedAppSource(ctx, appId, {
    hostname: config.auroraEndpoint!,
    region,
    stackPrefix: config.stackPrefix,
    credentials,
  });
  const comparison = compareWithDeployed(appDir, deployed);
  const note = comparisonNote(comparison, `${appId} in the cloud`);
  if (note) emit({ type: "progress", message: note });
  if (!input.allowBackward) {
    assertNotBackward(
      comparison,
      `${appId} in the cloud`,
      `\`starkeep install ${appId} --cloud --force\``,
    );
  } else if (comparison.kind === "backward" || comparison.kind === "unknown-commit") {
    emit({
      type: "progress",
      message: `Warning: the cloud runs changes to ${appId} that this folder lacks, and this deploy removes them (forced).`,
    });
  }

  let zipBuffer: Buffer | undefined;
  if (build?.ok) {
    // Print the anonymous surface before any work, so it shows whether or not
    // the install succeeds. Anything printed was declared on purpose.
    const anonymousReport = formatAnonymousRouteReport(manifest);
    if (anonymousReport) emit({ type: "progress", message: anonymousReport });
    fillPlatformEnv(manifest, config, config.cloudAppsUserPoolClientId!);
    await installDependencies(ctx, build.install, emit);
    zipBuffer = await buildBundle(ctx, build.bundle, `/apps/${appId}`, config.publicBaseUrl, emit);
    emit({
      type: "progress",
      message: `Bundle size: ${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB`,
    });
  }

  emit({ type: "progress", message: `Installing ${appId}…` });
  const install = ctx.overrides?.installApp ?? installApp;
  await install(
    cloudInstallInput({
      appId,
      appDir,
      manifest,
      surfaces,
      ...(zipBuffer ? { zipBuffer } : {}),
      config,
      region,
      accountId,
      registryCredentials: credentials,
    }),
  );

  if (!installsWeb) {
    const lines = [
      `${appId} is installed${surfaces.length > 0 ? ` with its ${surfaces.join(" and ")} app` : ""}.`,
    ];
    const android = surfaces.includes("mobile") ? manifest.mobile?.android : undefined;
    if (android) {
      lines.push(
        `Registered ${android.package}, signing in at ${android.callbackScheme}://auth/callback.`,
      );
    }
    emit({ type: "progress", message: lines.join("\n") });
    return { appId, surfaces };
  }

  const base = config.publicBaseUrl ?? config.apiGatewayUrl;
  if (!base) {
    emit({
      type: "progress",
      message:
        "Warning: skipping the post-install probe: the config has no publicBaseUrl or apiGatewayUrl, " +
        "so there is no live URL to ask.",
    });
    return { appId, surfaces };
  }
  // Ask the deployment what is actually anonymous, rather than trusting the
  // manifest. The two can disagree, and the August exposure is what that
  // disagreement looks like.
  const probe = ctx.overrides?.probeAnonymousSurface ?? probeAnonymousSurface;
  const report = await probe(manifest, base);
  emit({ type: "progress", message: formatProbeReport(report) });
  for (const r of report.unreachablePublicPaths) {
    emit({
      type: "progress",
      message: `Warning: ${r.url} is declared public but answered ${r.status}.`,
    });
  }
  if (report.coldStart?.level === "warn") {
    emit({
      type: "progress",
      message:
        `Warning: the "${report.coldStart.handlerName}" handler's first request took ` +
        `${(report.coldStart.elapsedMs / 1000).toFixed(1)}s of its ${report.coldStart.timeoutMs / 1000}s timeout.`,
    });
  }
  if (report.exposed) {
    throw new OperationError(
      "INSTALL_FAILED",
      `${appId} is installed but EXPOSED. Take it down before doing anything else:\n` +
        `  starkeep uninstall ${appId} --web`,
    );
  }
  // Four fifths of the timeout fails the install: the app loads its module
  // graph inside the handler, and the next cold start on a slower container
  // times out. Checked after the exposure verdict, so the takedown
  // instruction wins when both fire.
  if (report.coldStart?.level === "fail") {
    throw new OperationError(
      "INSTALL_FAILED",
      `${appId} is installed but its "${report.coldStart.handlerName}" handler spent ` +
        `${(report.coldStart.elapsedMs / 1000).toFixed(1)}s of its ${report.coldStart.timeoutMs / 1000}s ` +
        "timeout on the first request.\nLoad the app's module graph at module scope: build the entry " +
        "with createLambdaEntry or createWebAppHandler from @starkeep/app-client. See docs/authoring-an-app.md §7.",
    );
  }
  // No trailing slash: the app root is registered as `ANY /apps/<appId>`, and
  // only that spelling works on a deployment with no distribution.
  const url = `${base}/apps/${appId}`;
  emit({ type: "progress", message: `Install complete. ${appId} is available at:\n  ${url}` });
  return { appId, surfaces, url };
};
