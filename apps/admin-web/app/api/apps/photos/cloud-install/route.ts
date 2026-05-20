import { spawn, type ChildProcess } from "node:child_process";
import { NextRequest } from "next/server";
import { REPO_ROOT } from "../../../../../src/lib/exec-commands";

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

export async function POST(req: NextRequest) {
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

  const spawnEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: body.accessKeyId,
    AWS_SECRET_ACCESS_KEY: body.secretAccessKey,
    AWS_SESSION_TOKEN: body.sessionToken,
    AWS_REGION: body.region,
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
          emitEvent("done", { appId: "photos" });
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
          ["--filter", "@starkeep/admin-installer", "cli:install-photos", "--non-interactive"],
          { cwd: REPO_ROOT, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] },
        );
        runningChild = child;
        runningChildDone = finish;

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
