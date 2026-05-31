import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { NextRequest } from "next/server";
import { REPO_ROOT } from "../../../../../src/lib/exec-commands";

const STARKEEP_DATA_DIR = process.env.STARKEEP_DATA_DIR ?? join(homedir(), ".starkeep");

let runningChild: ChildProcess | null = null;
const runningChildListeners = new Map<symbol, (line: string) => void>();
let runningChildDone: ((code: number | null) => void) | null = null;

function broadcastLine(line: string): void {
  for (const listener of runningChildListeners.values()) {
    try {
      listener(line);
    } catch { /* closed controller — will be cleaned up on cancel */ }
  }
}

const EXPIRED_TOKEN_SIGNATURES = [
  "ExpiredToken",
  "ExpiredTokenException",
  "The security token included in the request is expired",
];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ appId: string }> },
) {
  const { appId } = await params;
  const body = (await req.json()) as {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    region: string;
  };

  if (!body.accessKeyId || !body.secretAccessKey || !body.sessionToken || !body.region) {
    return new Response(
      JSON.stringify({ error: "accessKeyId, secretAccessKey, sessionToken, region required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // TEMP (iam-permission-tests POC): capture two traces during install so
  // packages/iam-permission-tests can replay every AWS call through
  // iam-simulate against the install-app context.
  //   - <appId>-install.trace:     pulumi-aws HTTP traffic (via PULUMI_OPTION_*)
  //   - <appId>-install.sdk.trace: Node-side @aws-sdk client calls
  // Remove this block, the env vars, and the file-tee in spawnChild when
  // the POC graduates or is dropped.
  const traceFilePath = join(STARKEEP_DATA_DIR, `${appId}-install.trace`);
  const sdkTraceFilePath = join(STARKEEP_DATA_DIR, `${appId}-install.sdk.trace`);

  const spawnEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: body.accessKeyId,
    AWS_SECRET_ACCESS_KEY: body.secretAccessKey,
    AWS_SESSION_TOKEN: body.sessionToken,
    AWS_REGION: body.region,
    // TEMP (iam-permission-tests POC) — remove with the block above.
    TF_LOG: "DEBUG",
    PULUMI_OPTION_LOGFLOW: "true",
    PULUMI_OPTION_LOGTOSTDERR: "true",
    PULUMI_OPTION_VERBOSE: "9",
    IAM_SDK_TRACE_PATH: sdkTraceFilePath,
  };

  const encoder = new TextEncoder();
  const listenerId = Symbol();

  const stream = new ReadableStream({
    start(controller) {
      let sawExpiredToken = false;

      const emit = (line: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
        } catch { /* controller closed */ }
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
          emitEvent("done", { appId });
        } else if (sawExpiredToken) {
          emitEvent("error", {
            message:
              "Your AWS sign-in session expired while the deploy was running. Sign in again to retry.",
            code: "EXPIRED_TOKEN",
          });
        } else {
          emitEvent("error", { message: `Deploy exited with code ${code}` });
        }
        controller.close();
      };

      const spawnChild = () => {
        const child = spawn(
          "pnpm",
          ["--filter", "@starkeep/admin-installer", "cli:install-app", appId, "--non-interactive"],
          { cwd: REPO_ROOT, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] },
        );
        runningChild = child;
        runningChildDone = finish;

        // TEMP (iam-permission-tests POC): tee child stdout+stderr to a file
        // so we have a complete trace after the install regardless of whether
        // the SSE client stayed connected. Overwrites on each fresh spawn.
        // Remove with the env-var block in the POST handler when done.
        let traceFile: WriteStream | null = null;
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

        runningChildListeners.set(listenerId, (line) => {
          if (!sawExpiredToken && EXPIRED_TOKEN_SIGNATURES.some((sig) => line.includes(sig))) {
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
        emit("[Reconnected to in-progress deploy]");

        runningChildListeners.set(listenerId, (line) => {
          if (!sawExpiredToken && EXPIRED_TOKEN_SIGNATURES.some((sig) => line.includes(sig))) {
            sawExpiredToken = true;
          }
          emit(line);
        });

        runningChildDone = (code) => {
          if (code === 0) {
            finish(code);
          } else {
            emit("[Previous run ended — starting fresh deploy...]");
            sawExpiredToken = false;
            spawnChild();
          }
        };
        return;
      }

      spawnChild();
    },

    cancel() {
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
