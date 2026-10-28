import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
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

  return installStream({
    key: "app",
    noun: "deploy",
    command: "pnpm",
    args: [
      "--filter",
      "@starkeep/admin-installer",
      "cli:install-app",
      appId,
      "--non-interactive",
      ...(body.surfaces?.includes("web") ? ["--web"] : []),
      ...(body.surfaces?.includes("mobile") ? ["--mobile"] : []),
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
