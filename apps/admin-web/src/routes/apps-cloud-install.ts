import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { appSource, pinnedSourceState } from "../lib/app-scan";
import { REPO_ROOT } from "../lib/exec-commands";
import { installStream } from "../lib/install-stream";

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
  // The CLI deploys the manifest in the folder, and the tile asked for
  // consent against the manifest the user approved locally. Deploy only
  // when the two are the same, so the cloud never runs a manifest nobody
  // approved.
  if (source.kind === "pinned" && pinnedSourceState(source.appDir, source.manifest) !== null) {
    return Response.json(
      {
        error: `App ${appId}'s folder ${source.appDir} holds a manifest you have not approved. Choose Update from folder on its local card first.`,
      },
      { status: 409 },
    );
  }

  // iam-permission-tests POC capture — gated by PULUMI_VERBOSE_TRACE above:
  //   - <appId>-install.trace:     pulumi-aws HTTP traffic (via PULUMI_OPTION_*)
  //   - <appId>-install.sdk.trace: Node-side @aws-sdk client calls
  const traceFilePath = join(STARKEEP_DIR, `${appId}-install.trace`);
  const sdkTraceFilePath = join(STARKEEP_DIR, `${appId}-install.sdk.trace`);

  const spawnEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: body.accessKeyId,
    AWS_SECRET_ACCESS_KEY: body.secretAccessKey,
    AWS_SESSION_TOKEN: body.sessionToken,
    AWS_REGION: body.region,
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
