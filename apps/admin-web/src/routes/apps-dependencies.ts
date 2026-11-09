/**
 * An app's dependency install, the step Install runs before it registers the
 * app with the local data server.
 *
 * GET answers which command Install would run, so the consent dialog can name
 * it: `{ kind: "run", display, cwd }`, `{ kind: "skip", reason }` (the folder
 * holds no package.json), or `{ kind: "refused", display, cwd, reason }` (the
 * manifest names a command off the approved list, which the user can run by
 * hand). POST runs an approved command and streams its output, the way the
 * cloud installs stream theirs (see `lib/install-stream.ts`).
 *
 * The folder is the one Install reads the manifest from: an installed app's
 * pinned folder, which Update from folder reinstalls, or the scan's find for
 * a first install. The command comes from that folder's manifest as it is now.
 */

import { readFolderManifest, type FolderManifest } from "@starkeep/admin-installer/app-discovery";
import {
  resolveInstallCommand,
  type CommandResolution,
  type CommandSource,
} from "@starkeep/admin-installer/approved-commands";
import { appSource } from "../lib/app-scan";
import { installStream } from "../lib/install-stream";

type Params = { params: Promise<{ appId: string }> };

async function resolutionFor(appId: string): Promise<CommandResolution | Response> {
  const source = await appSource(appId);
  if (source.kind === "not-found") {
    return Response.json(
      { error: `App ${appId} not found in any configured parent dir` },
      {
        status: 404,
      },
    );
  }
  const folder: FolderManifest = readFolderManifest(source.appDir);
  if (folder.kind !== "valid") {
    return Response.json(
      { error: `App ${appId}'s source folder ${source.appDir} holds no valid manifest` },
      { status: 409 },
    );
  }
  return resolveInstallCommand(source.appDir, folder.raw as CommandSource);
}

export async function GET(_req: Request, { params }: Params) {
  const { appId } = await params;
  const resolution = await resolutionFor(appId);
  if (resolution instanceof Response) return resolution;
  if (resolution.kind === "run") {
    const { display, cwd } = resolution;
    return Response.json({ kind: "run", display, cwd });
  }
  return Response.json(resolution);
}

export async function POST(req: Request, { params }: Params) {
  const { appId } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    reattach?: boolean;
    resumeFrom?: string;
  };
  const resolution = await resolutionFor(appId);
  if (resolution instanceof Response) return resolution;
  if (resolution.kind !== "run") {
    return Response.json(
      {
        error:
          resolution.kind === "skip"
            ? resolution.reason
            : `Install does not run \`${resolution.display}\`: ${resolution.reason}`,
      },
      { status: 409 },
    );
  }
  return installStream({
    key: `deps:${encodeURIComponent(appId)}`,
    noun: "dependency install",
    command: resolution.command,
    args: resolution.args,
    cwd: resolution.cwd,
    env: process.env,
    reattach: body.reattach === true,
    ...(typeof body.resumeFrom === "string" ? { resumeFrom: body.resumeFrom } : {}),
    failureMessage: (code) => `\`${resolution.display}\` exited with code ${code}`,
    onSuccess: () => ({ event: "done", data: { appId } }),
  });
}
