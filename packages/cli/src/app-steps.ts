/**
 * Steps that install and update share: resolving an app reference, running
 * the approved dependency install, and registering the app locally.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  expandHome,
  readFolderManifest,
  type FolderManifest,
} from "@starkeep/admin-installer/app-discovery";
import {
  resolveInstallCommand,
  unattendedArgs,
  type CommandResolution,
  type CommandSource,
} from "@starkeep/admin-installer/approved-commands";
import { installLocalApp } from "@starkeep/admin-installer/local-app-install";
import { appParentDirs, appSource, scanApps } from "@starkeep/operator/apps";
import { patchConfig, readConfigSeeded } from "@starkeep/operator/config";
import { localDataServerUp } from "@starkeep/operator/local-apps";
import { localDataServerUrlFromEnv } from "@starkeep/operator/urls";
import { CliError } from "./errors";
import { openOperationLog, type Io } from "./io";

/** Whether a typed reference names a folder rather than an app id. */
export function isPathReference(ref: string): boolean {
  return ref.startsWith(".") || ref.startsWith("/") || ref.startsWith("~") || ref.includes("/");
}

export interface ResolvedApp {
  appId: string;
  appDir: string;
  folder: Extract<FolderManifest, { kind: "valid" }>;
}

/** Read and validate the manifest in `appDir`, or fail with the reason. */
export function validFolder(appDir: string): Extract<FolderManifest, { kind: "valid" }> {
  const folder = readFolderManifest(appDir);
  if (folder.kind === "missing") throw new CliError(`${appDir} holds no starkeep.manifest.json.`);
  if (folder.kind === "invalid") {
    throw new CliError(`The manifest in ${appDir} failed validation: ${folder.error}`);
  }
  return folder;
}

/**
 * Resolve an app id through the installed pin or the discovery folders, or a
 * path to the folder it names. Installing by path registers the folder with
 * discovery, so later commands accept the id.
 */
export async function resolveAppReference(io: Io, ref: string): Promise<ResolvedApp> {
  if (isPathReference(ref)) {
    const appDir = resolve(io.cwd, expandHome(ref));
    if (!existsSync(appDir) || !statSync(appDir).isDirectory()) {
      throw new CliError(`${appDir} is not a folder.`);
    }
    const folder = validFolder(appDir);
    registerFolder(io, appDir, folder.manifest.id);
    return { appId: folder.manifest.id, appDir, folder };
  }
  const source = await appSource(ref);
  if (source.kind === "not-found") {
    throw new CliError(
      `No app "${ref}" in the discovery folders. Add its folder with \`starkeep source add <dir>\`, or install it by path.`,
    );
  }
  if (source.kind === "pinned-missing") {
    throw new CliError(
      `${ref}'s source folder ${source.appDir} no longer holds a starkeep.manifest.json. Restore the folder first.`,
    );
  }
  const folder = validFolder(source.appDir);
  if (folder.manifest.id !== ref) {
    throw new CliError(`${source.appDir} now holds the app "${folder.manifest.id}", not "${ref}".`);
  }
  return { appId: ref, appDir: source.appDir, folder };
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Add `appDir` to the discovery folders unless the scan already finds the app there. */
function registerFolder(io: Io, appDir: string, appId: string): void {
  readConfigSeeded();
  const found = scanApps().apps.find((a) => a.appId === appId);
  if (found && realOrSelf(found.appDir) === realOrSelf(appDir)) return;
  const dirs = appParentDirs();
  patchConfig({ appParentDirs: [...dirs, appDir] });
  io.event({ type: "progress", message: `Added ${appDir} to the discovery folders.` });
}

export async function requireDataServer(): Promise<void> {
  if (!(await localDataServerUp())) {
    throw new CliError(
      `The local data server at ${localDataServerUrlFromEnv()} is not answering. Run \`starkeep start data-server\`, then try again.`,
    );
  }
}

export function installCommandFor(app: ResolvedApp): CommandResolution {
  return resolveInstallCommand(app.appDir, app.folder.raw as CommandSource);
}

/** Run the approved dependency install, with its output in a log file. */
export async function runDependencyInstall(
  io: Io,
  appId: string,
  install: CommandResolution,
): Promise<void> {
  if (install.kind === "skip") return;
  if (install.kind === "refused") {
    throw new CliError(`${appId}'s dependency install was refused: ${install.reason}`);
  }
  const log = openOperationLog(`install-deps-${appId}`);
  io.event({
    type: "progress",
    message: `Installing dependencies (${install.display} in ${install.cwd})…`,
  });
  log.write(`$ ${install.display}  (in ${install.cwd})`);
  const code = await new Promise<number | null>((done) => {
    const child = spawn(install.command, unattendedArgs(install.command, install.args), {
      cwd: install.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      log.write(text);
      for (const line of text.split("\n")) if (line.trim()) io.event({ type: "log", line });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      log.write(`Could not run ${install.command}: ${err.message}`);
      done(null);
    });
    child.on("close", (c) => done(c));
  });
  if (code !== 0) {
    throw new CliError(
      `The dependency install failed (${install.display} exited ${code ?? "without a code"}). See ${log.path}.`,
      1,
      "INSTALL_FAILED",
      log.path,
    );
  }
}

/** Register the app with the local data server and write its credentials file. */
export async function registerLocally(app: ResolvedApp): Promise<string> {
  const result = await installLocalApp({
    manifest: app.folder.raw,
    sourceDir: app.appDir,
    dataServerUrl: localDataServerUrlFromEnv(),
  });
  if (!result.ok) {
    const details = result.details?.length ? `\n  - ${result.details.join("\n  - ")}` : "";
    throw new CliError(`${result.error}${details}`);
  }
  return result.secretPath;
}
