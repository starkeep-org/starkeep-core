/**
 * Install (or re-install / update) the cloud-data-server built-in app.
 *
 * Runs `packages/admin-installer/scripts/cli-install-cloud-data-server.ts`
 * as a detached process and streams its output to the browser via SSE (see
 * `lib/install-stream.ts`). Running Pulumi out-of-process keeps `@pulumi/*`
 * (and the rest of the installer source tree) out of admin-web's dev bundle —
 * the dev server was OOMing because the bundler kept those module graphs hot.
 * Running it detached keeps it alive through admin-web restarts, which this
 * very install causes by rebuilding `@starkeep/protocol-primitives`.
 *
 * Request body: { accessKeyId, secretAccessKey, sessionToken, reattach?, resumeFrom? }
 *
 * Response: text/event-stream
 *   data:  <stdout/stderr line>
 *   event: done   data: { apiGatewayUrl, apiGatewayId, authorizerId,
 *                          sessionAuthorizerId,
 *                         bucketName, region, auroraHostname }
 *   event: error  data: { message: string, code?: "EXPIRED_TOKEN" | ... }
 *
 * Structured error codes let the client distinguish recoverable failures
 * (e.g. the Cognito-minted STS session expired mid-install) from generic
 * installer errors, so the UI can route the user to the right remedy
 * rather than dumping a stack trace.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { REPO_ROOT } from "../lib/exec-commands";
import { getRegion } from "../lib/cloud-config";
import { installStream } from "../lib/install-stream";

const STARKEEP_DIR = starkeepDir();
const CONFIG_PATH = join(STARKEEP_DIR, "config.json");

// Flip to true to re-enable the iam-permission-tests POC capture:
//   - sets PULUMI_OPTION_VERBOSE=9 + LOGTOSTDERR + LOGFLOW and TF_LOG=DEBUG so
//     pulumi-aws emits its full HTTP trace on stderr;
//   - sets IAM_SDK_TRACE_PATH so the Node-side @aws-sdk wrapper appends to a
//     parallel sdk.trace file;
//   - copies the run's full output to cds-install.trace when it ends.
// Off by default — install logs stay quiet. Pairs with the matching flag
// in packages/admin-installer/src/compute-stack.ts.
const PULUMI_VERBOSE_TRACE = false;

interface StarkeepConfig {
  userPoolId: string;
  apiGatewayUrl?: string;
  publicBaseUrl?: string;
  apiGatewayId?: string;
  apiGatewayExecutionArn?: string;
  authorizerId?: string;
  sessionAuthorizerId?: string;
  s3Bucket?: string;
  auroraEndpoint?: string;
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    reattach?: boolean;
    resumeFrom?: string;
  };

  if (!body.accessKeyId || !body.secretAccessKey || !body.sessionToken) {
    return new Response(
      JSON.stringify({ error: "accessKeyId, secretAccessKey, sessionToken required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!existsSync(CONFIG_PATH)) {
    return new Response(JSON.stringify({ error: `~/.starkeep/config.json not found` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const preConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StarkeepConfig;

  if (!preConfig.userPoolId) {
    return new Response(
      JSON.stringify({
        error:
          "~/.starkeep/config.json has no userPoolId — complete the wizard's Stack outputs step first",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const region = getRegion(preConfig);

  // iam-permission-tests POC capture — gated by PULUMI_VERBOSE_TRACE above:
  //   - cds-install.trace: pulumi-aws HTTP traffic (via PULUMI_OPTION_*)
  //   - cds-install.sdk.trace: Node-side @aws-sdk client calls made by the
  //     installer itself (IAM CreateRole, STS AssumeRole, DSQL signer, …)
  const traceFilePath = join(STARKEEP_DIR, "cds-install.trace");
  const sdkTraceFilePath = join(STARKEEP_DIR, "cds-install.sdk.trace");

  const spawnEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: body.accessKeyId,
    AWS_SECRET_ACCESS_KEY: body.secretAccessKey,
    AWS_SESSION_TOKEN: body.sessionToken,
    AWS_REGION: region,
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
    key: "cloud-data-server",
    noun: "install",
    command: "pnpm",
    args: [
      "--filter",
      "@starkeep/admin-installer",
      "cli:install-cloud-data-server",
      "--non-interactive",
    ],
    cwd: REPO_ROOT,
    env: spawnEnv,
    reattach: body.reattach === true,
    ...(typeof body.resumeFrom === "string" ? { resumeFrom: body.resumeFrom } : {}),
    ...(PULUMI_VERBOSE_TRACE ? { copyLogTo: traceFilePath } : {}),
    failureMessage: (code) => `Installer exited with code ${code}`,
    onSuccess: () => {
      // NB: this pass rewrites ~/.starkeep/config.json with the new
      // apiGatewayUrl / S3 / DSQL outputs, which the local-data-server only
      // reads at boot — so the daemon needs a restart to pick up the new
      // cloud. That restart is deliberately NOT done here: this is only the
      // first of two deploy passes (cloud-data-server, then Drive), and
      // bouncing the daemon mid-deploy both raced with pass 2's auth refresh
      // and booted the daemon against a half-provisioned cloud. The wizard
      // fires a single restart via /api/exec/daemon after the final pass.
      try {
        const post = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StarkeepConfig;
        return {
          event: "done",
          data: {
            apiGatewayUrl: post.apiGatewayUrl,
            publicBaseUrl: post.publicBaseUrl,
            apiGatewayId: post.apiGatewayId,
            apiGatewayExecutionArn: post.apiGatewayExecutionArn,
            authorizerId: post.authorizerId,
            sessionAuthorizerId: post.sessionAuthorizerId,
            bucketName: post.s3Bucket,
            auroraHostname: post.auroraEndpoint,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          event: "error",
          data: { message: `Install completed but reading outputs failed: ${msg}` },
        };
      }
    },
  });
}
