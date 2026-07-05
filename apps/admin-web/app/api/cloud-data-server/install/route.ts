/**
 * Install (or re-install / update) the cloud-data-server built-in app.
 *
 * Spawns `packages/admin-installer/scripts/cli-install-cloud-data-server.ts`
 * as a child process and streams its stdout/stderr to the browser via SSE.
 * Running Pulumi out-of-process keeps `@pulumi/*` (and the rest of the
 * installer source tree) out of admin-web's dev bundle — the dev server was
 * OOMing because the bundler kept those module graphs hot.
 *
 * Request body: { accessKeyId, secretAccessKey, sessionToken }
 *
 * Response: text/event-stream
 *   data:  <stdout/stderr line>
 *   event: done   data: { apiGatewayUrl, apiGatewayId, authorizerId,
 *                         bucketName, region, auroraHostname }
 *   event: error  data: { message: string, code?: "EXPIRED_TOKEN" | ... }
 *
 * Structured error codes let the client distinguish recoverable failures
 * (e.g. the Cognito-minted STS session expired mid-install) from generic
 * installer errors, so the UI can route the user to the right remedy
 * rather than dumping a stack trace.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { NextRequest } from "next/server";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";
import { getRegion } from "../../../../src/lib/cloud-config";
import { isCredentialFailureLine } from "../../../../src/lib/credential-errors";

const STARKEEP_DIR = starkeepDir();
const CONFIG_PATH = join(STARKEEP_DIR, "config.json");

// Flip to true to re-enable the iam-permission-tests POC capture:
//   - sets PULUMI_OPTION_VERBOSE=9 + LOGTOSTDERR + LOGFLOW and TF_LOG=DEBUG so
//     pulumi-aws emits its full HTTP trace on stderr;
//   - sets IAM_SDK_TRACE_PATH so the Node-side @aws-sdk wrapper appends to a
//     parallel sdk.trace file;
//   - tees the child's stdout+stderr to cds-install.trace alongside.
// Off by default — install logs stay quiet. Pairs with the matching flag
// in packages/admin-installer/src/compute-stack.ts.
const PULUMI_VERBOSE_TRACE = false;

// Module-level store for an in-progress install. When the browser suspends
// (laptop sleep) the SSE connection drops but the child keeps running. A
// subsequent POST from the reconnecting client reattaches to the existing
// child rather than spawning a duplicate, then auto-restarts if the old run
// failed.
let runningChild: ChildProcess | null = null;
// Listeners are stored as a Map so each SSE stream can remove its own entry
// when it disconnects, preventing writes to closed controllers.
const runningChildListeners = new Map<symbol, (line: string) => void>();
let runningChildDone: ((code: number | null) => void) | null = null;

function broadcastLine(line: string): void {
  for (const listener of runningChildListeners.values()) {
    try {
      listener(line);
    } catch {
      // Listener's controller was already closed — harmless, will be removed
      // when that stream's cancel() fires.
    }
  }
}

interface StarkeepConfig {
  userPoolId: string;
  apiGatewayUrl?: string;
  apiGatewayId?: string;
  apiGatewayExecutionArn?: string;
  authorizerId?: string;
  s3Bucket?: string;
  auroraEndpoint?: string;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };

  if (!body.accessKeyId || !body.secretAccessKey || !body.sessionToken) {
    return new Response(
      JSON.stringify({ error: "accessKeyId, secretAccessKey, sessionToken required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!existsSync(CONFIG_PATH)) {
    return new Response(
      JSON.stringify({ error: `~/.starkeep/config.json not found` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
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

  const encoder = new TextEncoder();
  // Unique key so cancel() can remove exactly this stream's listener.
  const listenerId = Symbol();

  const stream = new ReadableStream({
    start(controller) {
      let sawExpiredToken = false;

      const emit = (line: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
        } catch {
          // Controller already closed (e.g. client disconnected).
        }
      };

      const emitEvent = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {}
      };

      const finish = (code: number | null) => {
        if (code === 0) {
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
            emitEvent("done", {
              apiGatewayUrl: post.apiGatewayUrl,
              apiGatewayId: post.apiGatewayId,
              apiGatewayExecutionArn: post.apiGatewayExecutionArn,
              authorizerId: post.authorizerId,
              bucketName: post.s3Bucket,
              auroraHostname: post.auroraEndpoint,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            emitEvent("error", { message: `Install completed but reading outputs failed: ${msg}` });
          }
        } else if (sawExpiredToken) {
          emitEvent("error", {
            message:
              "Your AWS sign-in session was rejected (expired or invalid). Sign in again to retry.",
            code: "EXPIRED_TOKEN",
          });
        } else {
          emitEvent("error", { message: `Installer exited with code ${code}` });
        }
        controller.close();
      };

      // Spawn a new child process using the credentials from this POST request.
      const spawnChild = () => {
        const child = spawn(
          "pnpm",
          ["--filter", "@starkeep/admin-installer", "cli:install-cloud-data-server", "--non-interactive"],
          { cwd: REPO_ROOT, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] },
        );
        runningChild = child;
        runningChildDone = finish;

        // iam-permission-tests POC: tee child stdout+stderr to a file so we
        // have a complete trace after the install regardless of whether the
        // SSE client stayed connected. Gated by PULUMI_VERBOSE_TRACE.
        let traceFile: WriteStream | null = null;
        if (PULUMI_VERBOSE_TRACE) {
          try {
            traceFile = createWriteStream(traceFilePath, { flags: "w" });
          } catch (err) {
            console.warn(`[iam-trace] could not open ${traceFilePath}: ${err}`);
          }
          if (traceFile) {
            child.stdout.pipe(traceFile, { end: false });
            child.stderr.pipe(traceFile, { end: false });
            child.on("close", () => traceFile?.end());
          }
        }

        runningChildListeners.set(listenerId, (line) => {
          if (!sawExpiredToken && isCredentialFailureLine(line)) {
            sawExpiredToken = true;
          }
          emit(line);
        });

        let buffer = "";
        const onChunk = (chunk: Buffer) => {
          buffer += chunk.toString();
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.length > 0) broadcastLine(line);
          }
        };
        child.stdout.on("data", onChunk);
        child.stderr.on("data", onChunk);

        child.on("error", (err) => {
          runningChild = null;
          runningChildListeners.clear();
          runningChildDone = null;
          emitEvent("error", { message: err.message });
          controller.close();
        });

        child.on("close", (code) => {
          if (buffer.length > 0) broadcastLine(buffer);
          runningChild = null;
          runningChildListeners.clear();
          const done = runningChildDone;
          runningChildDone = null;
          if (done) done(code);
        });
      };

      if (runningChild !== null) {
        // Reattach to the still-running child from a prior (suspended) request.
        // If that run fails, auto-restart with the credentials from this POST.
        emit("[Reconnected to in-progress install]");

        runningChildListeners.set(listenerId, (line) => {
          if (!sawExpiredToken && isCredentialFailureLine(line)) {
            sawExpiredToken = true;
          }
          emit(line);
        });

        runningChildDone = (code) => {
          if (code === 0) {
            finish(code);
          } else {
            // Previous run failed — spawn fresh with the new credentials.
            emit("[Previous run ended — starting fresh install...]");
            sawExpiredToken = false;
            spawnChild();
          }
        };
        return;
      }

      spawnChild();
    },

    cancel() {
      // Client disconnected (e.g. laptop sleep). Remove this stream's listener
      // so future broadcasts don't try to write to its closed controller.
      // Leave the child running so the reconnect path can reattach.
      runningChildListeners.delete(listenerId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
