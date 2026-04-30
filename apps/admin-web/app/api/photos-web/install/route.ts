import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";

const PIDS_DIR = resolve(REPO_ROOT, ".pids");
const PID_FILE = resolve(PIDS_DIR, "photos-web.pid");
const META_FILE = resolve(PIDS_DIR, "photos-web.meta.json");
const LOG_FILE = resolve(PIDS_DIR, "photos-web.log");

// Next.js 16 logs: "- Local:         http://localhost:3001"
const PORT_RE = /localhost:(\d+)/;

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stopExisting() {
  if (!existsSync(PID_FILE)) return;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8"), 10);
  if (isAlive(pid)) process.kill(pid, "SIGTERM");
  unlinkSync(PID_FILE);
  if (existsSync(META_FILE)) unlinkSync(META_FILE);
}

function runStreamed(
  cmd: string,
  args: string[],
  cwd: string,
  emit: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    function emitLines(chunk: Buffer) {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) emit(line);
      }
    }
    child.stdout.on("data", emitLines);
    child.stderr.on("data", emitLines);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`exited with code ${code}`)));
    child.on("error", reject);
  });
}

function waitUntilReady(
  logPath: string,
  emit: (line: string) => void,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let offset = 0;
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      try {
        if (!existsSync(logPath)) return;
        const content = readFileSync(logPath, "utf-8");
        const newChunk = content.slice(offset);
        if (newChunk) {
          for (const line of newChunk.split("\n")) {
            if (line.trim()) emit(line);
          }
          offset = content.length;
          if (PORT_RE.test(content)) {
            clearInterval(interval);
            resolve();
            return;
          }
        }
        if (Date.now() > deadline) {
          clearInterval(interval);
          reject(new Error("Timed out waiting for dev server to start — check .pids/photos-web.log"));
        }
      } catch (err) {
        clearInterval(interval);
        reject(err);
      }
    }, 300);
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { photosWebPath: string };
  const { photosWebPath } = body;

  if (!photosWebPath) {
    return NextResponse.json({ error: "photosWebPath is required" }, { status: 400 });
  }

  const expandedPath = photosWebPath.replace(/^~/, process.env.HOME ?? "");

  if (!existsSync(expandedPath)) {
    return NextResponse.json({ error: `Directory not found: ${expandedPath}` }, { status: 400 });
  }

  // Read starkeep-config.json from the data-protocol repo
  const starkeepConfigPath = resolve(REPO_ROOT, "starkeep-config.json");
  let starkeepConfig: Record<string, unknown> = {};
  if (existsSync(starkeepConfigPath)) {
    starkeepConfig = JSON.parse(readFileSync(starkeepConfigPath, "utf-8")) as Record<string, unknown>;
  }

  // Merge with photos-specific cloud config if it exists in the photos repo
  const photosCloudConfigPath = resolve(expandedPath, "infra/photos-cloud-config.json");
  let photosCloudConfig: Record<string, unknown> = {};
  if (existsSync(photosCloudConfigPath)) {
    photosCloudConfig = JSON.parse(readFileSync(photosCloudConfigPath, "utf-8")) as Record<string, unknown>;
  }

  const runtimeConfig = {
    localDataServerUrl: "http://127.0.0.1:9820",
    ...starkeepConfig,
    ...photosCloudConfig,
  };

  const runtimeConfigPath = resolve(expandedPath, "public/starkeep-runtime-config.json");
  writeFileSync(runtimeConfigPath, JSON.stringify(runtimeConfig, null, 2));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (line: string) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));

      try {
        if (!existsSync(resolve(expandedPath, "node_modules"))) {
          emit("Installing dependencies...");
          // pnpm install must run from the workspace root (parent of photos)
          // so that workspace:* refs in @starkeep packages resolve correctly.
          const workspaceRoot = resolve(expandedPath, "..");
          await runStreamed("pnpm", ["install"], workspaceRoot, emit);
          emit("Dependencies installed.");
        }

        stopExisting();
        mkdirSync(PIDS_DIR, { recursive: true });

        emit("Starting dev server...");
        const port = await findFreePort();
        const logFd = openSync(LOG_FILE, "w");
        const child = spawn("pnpm", ["dev", "--port", String(port)], {
          cwd: expandedPath,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: { ...process.env },
        });
        child.unref();
        writeFileSync(PID_FILE, String(child.pid));

        // tail log until Next.js confirms it's listening, then we know the port is live
        await waitUntilReady(LOG_FILE, emit);
        writeFileSync(META_FILE, JSON.stringify({ pid: child.pid, port }));

        controller.enqueue(
          encoder.encode(`event: done\ndata: ${JSON.stringify({ port, pid: child.pid })}\n\n`),
        );
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(msg)}\n\n`));
        controller.close();
      }
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
