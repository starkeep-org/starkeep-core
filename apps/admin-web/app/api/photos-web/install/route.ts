import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";

const PIDS_DIR = resolve(REPO_ROOT, ".pids");
const PID_FILE = resolve(PIDS_DIR, "photos-web.pid");
const META_FILE = resolve(PIDS_DIR, "photos-web.meta.json");
const LOG_FILE = resolve(PIDS_DIR, "photos-web.log");

// Turbopack logs "✓ Ready in 305ms" — simpler to match than localhost:PORT which
// has ANSI escape codes interspersed between characters in the raw log file.
const READY_RE = /Ready in \d/;

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

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;?]*[A-Za-z]|\x1B\][^\x07]*\x07/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ""); }

export async function POST(req: NextRequest) {
  const body = await req.json() as { photosWebPath: string };
  const { photosWebPath } = body;

  if (!photosWebPath) {
    return NextResponse.json({ error: "photosWebPath is required" }, { status: 400 });
  }

  const expandedPath = photosWebPath.replace(/^~/, process.env.HOME ?? "");
  // Workspace root = parent of the photos app so Turbopack can resolve source files inside it
  const expandedWorkspace = dirname(expandedPath);

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
        // Generate pnpm-workspace.yaml (and a minimal package.json root marker if absent)
        // in the user-configured workspace directory so that workspace:* refs in photos
        // resolve to local @starkeep packages.
        mkdirSync(expandedWorkspace, { recursive: true });
        const relPackages = relative(expandedWorkspace, resolve(REPO_ROOT, "packages"));
        const relPhotos = relative(expandedWorkspace, expandedPath);
        const workspaceYaml = [
          "packages:",
          `  - "${relPackages}/*"`,
          `  - "${relPhotos}"`,
          `  - "${relPhotos}/infra"`,
        ].join("\n") + "\n";
        writeFileSync(resolve(expandedWorkspace, "pnpm-workspace.yaml"), workspaceYaml);
        const pkgJsonPath = resolve(expandedWorkspace, "package.json");
        if (!existsSync(pkgJsonPath)) {
          writeFileSync(pkgJsonPath, JSON.stringify({ private: true, name: "starkeep-workspace" }, null, 2) + "\n");
        }

        emit("Installing dependencies...");
        await runStreamed("pnpm", ["install"], expandedWorkspace, emit);
        emit("Dependencies installed.");

        stopExisting();
        mkdirSync(PIDS_DIR, { recursive: true });

        emit("Starting dev server...");
        const port = await findFreePort();

        // Spawn with piped stdio so data events fire directly — this is the only
        // reliable way to get real-time output through the SSE stream. setInterval
        // + log file polling doesn't trigger HTTP response flushes.
        const child = spawn("pnpm", ["dev", "--port", String(port)], {
          cwd: expandedPath,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
        });
        writeFileSync(PID_FILE, String(child.pid));

        const startLog: string[] = [];
        await new Promise<void>((resolveReady, rejectReady) => {
          const timer = setTimeout(() => {
            rejectReady(new Error(`Dev server did not start within 120s. Last output:\n${startLog.slice(-20).join("\n")}`));
          }, 120_000);

          function handleChunk(chunk: Buffer) {
            for (const raw of chunk.toString().split(/\r?\n/)) {
              const line = stripAnsi(raw).trim();
              if (!line) continue;
              startLog.push(line);
              emit(line);
              if (READY_RE.test(line)) {
                clearTimeout(timer);
                resolveReady();
              }
            }
          }

          child.stdout!.on("data", handleChunk);
          child.stderr!.on("data", handleChunk);
          child.on("error", (err) => { clearTimeout(timer); rejectReady(err); });
          child.on("close", (code) => {
            clearTimeout(timer);
            rejectReady(new Error(`Dev server exited with code ${code}. Output:\n${startLog.join("\n")}`));
          });
        });

        // Drain pipes so the process isn't blocked on writes, then detach.
        child.stdout!.resume();
        child.stderr!.resume();
        child.unref();
        writeFileSync(LOG_FILE, startLog.join("\n") + "\n");
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
