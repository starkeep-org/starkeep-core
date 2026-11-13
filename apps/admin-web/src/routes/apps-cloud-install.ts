import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { appSource, idMismatch, pinnedSourceState } from "../lib/app-scan";
import { MANIFEST_NOT_APPROVED } from "../lib/app-types";
import { REPO_ROOT } from "../lib/exec-commands";
import { installStream } from "../lib/install-stream";
import { installerEnv } from "@starkeep/admin-installer/aws-env";
import { readFolderManifest } from "@starkeep/admin-installer/app-discovery";
import { approvesManifest, manifestDigest } from "@starkeep/admin-installer/manifest-approval";

const STARKEEP_DIR = starkeepDir();

// Flip to true to re-enable the iam-permission-tests POC capture (verbose
// pulumi-aws HTTP trace + Node @aws-sdk trace + a copy of the run's output). Off by
// default — install logs stay quiet. Pairs with the matching flag in
// packages/admin-installer/src/compute-stack.ts and the cloud-data-server
// install route.
const PULUMI_VERBOSE_TRACE = false;

export async function POST(req: Request, { params }: { params: Promise<{ appId: string }> }) {
  const { appId } = await params;
  const body = (await req.json()) as {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    region: string;
    reattach?: boolean;
    resumeFrom?: string;
    /**
     * The surfaces to install on top of the app's data side; omitted, every
     * surface its manifest offers. See admin-installer's `AppSurface`.
     */
    surfaces?: string[];
    /**
     * The manifest the person approved: the one the update dialog or the
     * install consent showed, or, for a tile that asked nothing, the
     * manifest its card holds. The route deploys only when the app's folder
     * holds this manifest. A reattach, which starts no deploy, may omit it.
     */
    approvedManifest?: unknown;
  };

  if (!body.accessKeyId || !body.secretAccessKey || !body.sessionToken || !body.region) {
    return new Response(
      JSON.stringify({ error: "accessKeyId, secretAccessKey, sessionToken, region required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Resolve the folder here and hand it to the CLI, so the install deploys
  // the copy the Dashboard shows: the local pin when the app is installed on
  // this machine, otherwise the scan's find.
  const source = await appSource(appId);
  if (source.kind === "not-found") {
    return Response.json(
      { error: `App ${appId} not found in any configured app folder` },
      { status: 404 },
    );
  }
  if (source.kind === "pinned-missing") {
    return Response.json(
      { error: `App ${appId}'s source folder ${source.appDir} no longer holds a manifest` },
      { status: 409 },
    );
  }
  // The CLI deploys the manifest in the folder, so the folder must hold the
  // manifest the person approved. The route hands the CLI that manifest's
  // digest, and the CLI refuses a folder that changed after this check. A
  // reattach only follows a deploy already running, so it checks nothing.
  let digestArgs: string[] = [];
  if (body.reattach !== true) {
    const folder = readFolderManifest(source.appDir);
    if (folder.kind !== "valid") {
      const detail = folder.kind === "invalid" ? ` (${folder.error})` : "";
      return Response.json(
        {
          error: `App ${appId}'s folder ${source.appDir} holds no valid manifest${detail}. Fix the manifest first.`,
        },
        { status: 409 },
      );
    }
    // A folder that now holds another app would deploy that app under this id.
    if (folder.manifest.id !== appId) {
      return Response.json(
        {
          error: `App ${appId}'s folder ${source.appDir} holds an invalid manifest (${idMismatch(folder.manifest.id, appId)}). Fix the manifest first.`,
        },
        { status: 409 },
      );
    }
    if (body.approvedManifest === null || typeof body.approvedManifest !== "object") {
      return Response.json(
        { error: "A deploy requires the manifest the user approved (approvedManifest)" },
        { status: 400 },
      );
    }
    if (!approvesManifest(body.approvedManifest, folder.manifest)) {
      // A locally installed app's changed folder goes through the update
      // dialog, which shows the folder's manifest and approves it.
      const pinnedChanged =
        source.kind === "pinned" &&
        pinnedSourceState(source.appDir, source.manifest)?.sourceState === "changed";
      return Response.json(
        {
          error: pinnedChanged
            ? `App ${appId}'s folder ${source.appDir} holds a changed manifest. Choose Start or Redeploy to update it.`
            : `App ${appId}'s folder ${source.appDir} changed after you approved its manifest. Review the new manifest and deploy again.`,
          code: MANIFEST_NOT_APPROVED,
        },
        { status: 409 },
      );
    }
    digestArgs = ["--manifest-digest", manifestDigest(folder.manifest)];
  }

  // iam-permission-tests POC capture — gated by PULUMI_VERBOSE_TRACE above:
  //   - <appId>-install.trace:     pulumi-aws HTTP traffic (via PULUMI_OPTION_*)
  //   - <appId>-install.sdk.trace: Node-side @aws-sdk client calls
  const traceFilePath = join(STARKEEP_DIR, `${appId}-install.trace`);
  const sdkTraceFilePath = join(STARKEEP_DIR, `${appId}-install.sdk.trace`);

  const spawnEnv = {
    ...installerEnv(
      {
        accessKeyId: body.accessKeyId,
        secretAccessKey: body.secretAccessKey,
        sessionToken: body.sessionToken,
      },
      body.region,
    ),
    ...(PULUMI_VERBOSE_TRACE
      ? {
          TF_LOG: "DEBUG",
          PULUMI_OPTION_LOGFLOW: "true",
          PULUMI_OPTION_LOGTOSTDERR: "true",
          PULUMI_OPTION_VERBOSE: "9",
          IAM_SDK_TRACE_PATH: sdkTraceFilePath,
        }
      : {}),
  };

  const surfaceFlags = [
    ...(body.surfaces?.includes("web") ? ["web"] : []),
    ...(body.surfaces?.includes("mobile") ? ["mobile"] : []),
  ];

  return installStream({
    // Every cloud app install shares this slot, so each run records which app
    // and surfaces it installs, and a POST for another one gets a 409.
    key: "app",
    owner: `${appId} (${
      body.surfaces === undefined
        ? "every surface"
        : surfaceFlags.length > 0
          ? surfaceFlags.join(", ")
          : "data side only"
    })`,
    noun: "deploy",
    command: "pnpm",
    args: [
      "--filter",
      "@starkeep/admin-installer",
      "cli:install-app",
      appId,
      "--non-interactive",
      "--app-dir",
      source.appDir,
      ...surfaceFlags.map((surface) => `--${surface}`),
      ...digestArgs,
    ],
    cwd: REPO_ROOT,
    env: spawnEnv,
    reattach: body.reattach === true,
    ...(typeof body.resumeFrom === "string" ? { resumeFrom: body.resumeFrom } : {}),
    ...(PULUMI_VERBOSE_TRACE ? { copyLogTo: traceFilePath } : {}),
    failureMessage: (code) => `Deploy exited with code ${code}`,
    onSuccess: () => ({ event: "done", data: { appId } }),
  });
}
