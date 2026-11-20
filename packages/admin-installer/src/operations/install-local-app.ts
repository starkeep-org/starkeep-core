/**
 * Install an app on this computer, the way admin-web's Install button does:
 * run its approved dependency install, register it with the local data
 * server, and write its credentials file.
 *
 * The person approves the consent words first ({@link localInstallConsent}),
 * and the input says so with `approved: true`. The data server must be
 * running. This operation needs no cloud credentials.
 */
import { readFolderManifest, typedPath } from "../app-discovery";
import {
  resolveInstallCommand,
  unattendedArgs,
  type CommandResolution,
  type CommandSource,
} from "../approved-commands";
import { consentLines } from "../consent-text";
import { installLocalApp } from "../local-app-install";
import type { Operation } from "./context";
import { OperationError } from "./errors";
import { runCommand } from "./steps";

export interface InstallLocalAppInput {
  appDir: string;
  /** The person approved the consent words for this folder's manifest. */
  approved: boolean;
  /** The local data server. Defaults to `http://127.0.0.1:$STARKEEP_PORT`. */
  dataServerUrl?: string;
}

/** The app in `appDir`, its consent words and its dependency install, or the reason it has none. */
export function localInstallConsent(appDir: string): {
  appId: string;
  name: string;
  manifest: Record<string, unknown>;
  install: CommandResolution;
  lines: string[];
} {
  const folder = readFolderManifest(typedPath(appDir));
  if (folder.kind === "missing") {
    throw new OperationError("MANIFEST_INVALID", `${appDir} holds no starkeep.manifest.json.`);
  }
  if (folder.kind === "invalid") {
    throw new OperationError(
      "MANIFEST_INVALID",
      `The app's manifest failed validation: ${folder.error}`,
    );
  }
  const install = resolveInstallCommand(typedPath(appDir), folder.raw as CommandSource);
  return {
    appId: folder.manifest.id,
    name: folder.manifest.name ?? folder.manifest.id,
    manifest: folder.raw,
    install,
    lines: consentLines(folder.manifest, install),
  };
}

export function defaultDataServerUrl(): string {
  return (
    process.env.STARKEEP_LOCAL_DATA_SERVER_URL ??
    `http://127.0.0.1:${process.env.STARKEEP_PORT ?? "9820"}`
  );
}

export const installLocalAppOp: Operation<
  InstallLocalAppInput,
  { appId: string; secretPath: string }
> = async (ctx, input, emit) => {
  if (!input.appDir) throw new OperationError("INVALID_INPUT", "Name the app's folder.");
  const appDir = typedPath(input.appDir);
  const consent = localInstallConsent(appDir);
  const dataServerUrl = input.dataServerUrl ?? defaultDataServerUrl();
  const doFetch = ctx.overrides?.fetch ?? fetch;

  // The data server answers before anything runs, so a stopped server fails
  // here rather than after a dependency install.
  const health = await doFetch(`${dataServerUrl}/health`).catch(() => null);
  if (!health?.ok) {
    throw new OperationError(
      "INSTALL_FAILED",
      `The local data server at ${dataServerUrl} is not answering. Start it (starkeep start data-server), then try again.`,
    );
  }
  if (input.approved !== true) {
    emit({ type: "prompt-needed", reason: "consent", detail: consent.lines.join("\n") });
    throw new OperationError(
      "NOT_CONFIRMED",
      `Install ${consent.name} only after approving its consent words.`,
    );
  }

  if (consent.install.kind === "refused") {
    throw new OperationError(
      "COMMAND_NOT_APPROVED",
      `${consent.appId}'s dependency install was refused: ${consent.install.reason}`,
    );
  }
  if (consent.install.kind === "run") {
    const install = consent.install;
    emit({
      type: "progress",
      message: `Installing dependencies (${install.display} in ${install.cwd})…`,
    });
    const code = await (ctx.overrides?.runCommand ?? runCommand)(
      {
        command: install.command,
        args: unattendedArgs(install.command, install.args),
        cwd: install.cwd,
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

  const result = await (ctx.overrides?.installLocalApp ?? installLocalApp)({
    manifest: consent.manifest,
    sourceDir: appDir,
    dataServerUrl,
  });
  if (!result.ok) {
    const details = result.details?.length
      ? `\n${result.details.map((d) => `  - ${d}`).join("\n")}`
      : "";
    throw new OperationError(
      result.status === 400 || result.status === 422 ? "MANIFEST_INVALID" : "INSTALL_FAILED",
      `${result.error}${details}`,
    );
  }
  emit({
    type: "progress",
    message: `Installed ${consent.name}. Its credentials are in ${result.secretPath}.`,
  });
  return { appId: result.appId, secretPath: result.secretPath };
};
