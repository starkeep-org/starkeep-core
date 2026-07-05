/**
 * Install (or re-install / update) the Starkeep Drive built-in app — the
 * User-Data-Owner identity for all shared-record sync.
 *
 * Mirrors app/api/cloud-data-server/install/route.ts: spawns
 * `packages/admin-installer/scripts/cli-install-drive.ts` as a child process
 * and streams its stdout/stderr to the browser via SSE. Must run AFTER the
 * cloud-data-server install (which writes the foundational outputs this CLI
 * reads from ~/.starkeep/config.json) — the wizard sequences the two passes.
 *
 * Request body: { accessKeyId, secretAccessKey, sessionToken }
 *
 * Response: text/event-stream
 *   data:  <stdout/stderr line>
 *   event: done   data: {}
 *   event: error  data: { message: string, code?: "EXPIRED_TOKEN" }
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { NextRequest } from "next/server";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";
import { getRegion } from "../../../../src/lib/cloud-config";
import { isCredentialFailureLine } from "../../../../src/lib/credential-errors";

const STARKEEP_DIR = starkeepDir();
const CONFIG_PATH = join(STARKEEP_DIR, "config.json");

// Module-level store for an in-progress install (mirrors the cloud-data-server
// route): when the browser suspends, the SSE connection drops but the child
// keeps running; a reconnecting POST reattaches rather than spawning a dupe.
let runningChild: ChildProcess | null = null;
const runningChildListeners = new Map<symbol, (line: string) => void>();
let runningChildDone: ((code: number | null) => void) | null = null;

function broadcastLine(line: string): void {
  for (const listener of runningChildListeners.values()) {
    try {
      listener(line);
    } catch {
      // Listener's controller was already closed — harmless.
    }
  }
}

interface StarkeepConfig {
  userPoolId: string;
  auroraEndpoint?: string;
  s3Bucket?: string;
  apiGatewayId?: string;
  authorizerId?: string;
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
  // Drive depends on the cloud-data-server foundational outputs being present.
  if (!preConfig.auroraEndpoint || !preConfig.s3Bucket || !preConfig.apiGatewayId || !preConfig.authorizerId) {
    return new Response(
      JSON.stringify({
        error:
          "cloud-data-server outputs missing from config — run the cloud-data-server install first",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const region = getRegion(preConfig);

  const spawnEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: body.accessKeyId,
    AWS_SECRET_ACCESS_KEY: body.secretAccessKey,
    AWS_SESSION_TOKEN: body.sessionToken,
    AWS_REGION: region,
  };

  const encoder = new TextEncoder();
  const listenerId = Symbol();

  const stream = new ReadableStream({
    start(controller) {
      let sawExpiredToken = false;

      const emit = (line: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
        } catch {
          // Controller already closed (client disconnected).
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
          emitEvent("done", {});
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

      const spawnChild = () => {
        const child = spawn(
          "pnpm",
          ["--filter", "@starkeep/admin-installer", "cli:install-drive", "--non-interactive"],
          { cwd: REPO_ROOT, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] },
        );
        runningChild = child;
        runningChildDone = finish;

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
        emit("[Reconnected to in-progress Drive install]");
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
            emit("[Previous run ended — starting fresh Drive install...]");
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
