import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { appSource, idMismatch, pinnedSourceState } from "@starkeep/operator/apps";
import { MANIFEST_NOT_APPROVED } from "../lib/app-types";
import { REPO_ROOT } from "@starkeep/operator/commands";
import { operationCommand } from "@starkeep/operator/operation-runs";
import { installStream } from "../lib/install-stream";
import { installerEnv } from "@starkeep/admin-installer/aws-env";
import { readFolderManifest } from "@starkeep/admin-installer/app-discovery";
import { approvesManifest, manifestDigest } from "@starkeep/admin-installer/manifest-approval";
import { requireAdmin } from "../lib/admin-auth";

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

  // A reconnect only follows a run, so it needs no sign-in. Anything that may
  // start a run mints the admin's credentials here, on the server.
  const admin = body.reattach === true ? null : await requireAdmin();
  if (admin instanceof Response) return admin;

  // Resolve the folder here and hand it to the operation, so the install deploys
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
  // The operation deploys the manifest in the folder, so the folder must hold
  // the manifest the person approved. The route hands the operation that
  // manifest's digest, and the operation refuses a folder that changed after
  // this check. A
  // reattach only follows a deploy already running, so it checks nothing.
  let digest: string | undefined;
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
    digest = manifestDigest(folder.manifest);
  }

  // iam-permission-tests POC capture — gated by PULUMI_VERBOSE_TRACE above:
  //   - <appId>-install.trace:     pulumi-aws HTTP traffic (via PULUMI_OPTION_*)
  //   - <appId>-install.sdk.trace: Node-side @aws-sdk client calls
  const traceFilePath = join(STARKEEP_DIR, `${appId}-install.trace`);
  const sdkTraceFilePath = join(STARKEEP_DIR, `${appId}-install.sdk.trace`);

  const spawnEnv = {
    ...(admin
      ? installerEnv(
          {
            accessKeyId: admin.stsCredentials.accessKeyId,
            secretAccessKey: admin.stsCredentials.secretAccessKey,
            sessionToken: admin.stsCredentials.sessionToken,
          },
          admin.region,
        )
      : {}),
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

  const surfaces = [
    ...(body.surfaces?.includes("web") ? (["web"] as const) : []),
    ...(body.surfaces?.includes("mobile") ? (["mobile"] as const) : []),
  ];

  return installStream({
    // Every cloud app install shares this slot, so each run records which app
    // and surfaces it installs, and a POST for another one gets a 409.
    key: "app",
    owner: `${appId} (${
      body.surfaces === undefined
        ? "every surface"
        : surfaces.length > 0
          ? surfaces.join(", ")
          : "data side only"
    })`,
    noun: "deploy",
    // No surface named installs every surface the manifest offers, as an
    // unknown one alone does.
    ...operationCommand("install-cloud-app", {
      appId,
      appDir: source.appDir,
      ...(surfaces.length > 0 ? { surfaces } : {}),
      ...(digest !== undefined ? { manifestDigest: digest } : {}),
    }),
    cwd: REPO_ROOT,
    env: spawnEnv,
    reattach: body.reattach === true,
    ...(typeof body.resumeFrom === "string" ? { resumeFrom: body.resumeFrom } : {}),
    ...(PULUMI_VERBOSE_TRACE ? { copyLogTo: traceFilePath } : {}),
    failureMessage: (code) => `Deploy exited with code ${code}`,
    onSuccess: () => ({ event: "done", data: { appId } }),
  });
}
