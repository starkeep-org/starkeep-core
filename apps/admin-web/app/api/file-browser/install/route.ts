import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";

const PIDS_DIR = resolve(REPO_ROOT, ".pids");
const PID_FILE = resolve(PIDS_DIR, "file-browser.pid");
const META_FILE = resolve(PIDS_DIR, "file-browser.meta.json");
const LOG_FILE = resolve(PIDS_DIR, "file-browser.log");

// Vite logs: "  ➜  Local:   http://localhost:5173/"
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
          reject(new Error("Timed out waiting for dev server to start — check .pids/file-browser.log"));
        }
      } catch (err) {
        clearInterval(interval);
        reject(err);
      }
    }, 300);
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { fileBrowserPath: string };
  const { fileBrowserPath } = body;

  if (!fileBrowserPath) {
    return NextResponse.json({ error: "fileBrowserPath is required" }, { status: 400 });
  }

  const expandedPath = fileBrowserPath.replace(/^~/, process.env.HOME ?? "");

  if (!existsSync(expandedPath)) {
    return NextResponse.json({ error: `Directory not found: ${expandedPath}` }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (line: string) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));

      try {
        emit("Installing dependencies...");
        await runStreamed("pnpm", ["install", "--ignore-workspace"], expandedPath, emit);
        emit("Dependencies installed.");

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
