import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";
import type { STSCredentials } from "../../../../src/lib/cognito-auth";

export async function GET(req: NextRequest) {
  const photosWebPath = req.nextUrl.searchParams.get("path");
  if (!photosWebPath) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  const expandedPath = photosWebPath.replace(/^~/, process.env.HOME ?? "");
  const configPath = resolve(expandedPath, "infra/.sst/platform/photos-cloud-config.json");
  const deployed = existsSync(configPath);
  return NextResponse.json({ deployed });
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    photosWebPath: string;
    credentials: STSCredentials & { region: string };
  };
  const { photosWebPath, credentials } = body;

  if (!photosWebPath) {
    return NextResponse.json({ error: "photosWebPath is required" }, { status: 400 });
  }
  if (!credentials) {
    return NextResponse.json({ error: "credentials are required" }, { status: 400 });
  }

  const expandedPath = photosWebPath.replace(/^~/, process.env.HOME ?? "");
  // Workspace root = parent of the photos app so Turbopack can resolve source files inside it
  const expandedWorkspace = dirname(expandedPath);
  const infraPath = resolve(expandedPath, "infra");

  if (!existsSync(infraPath)) {
    return NextResponse.json({ error: `infra directory not found at ${infraPath}` }, { status: 400 });
  }

  // Read starkeep-config.json from data-protocol repo
  const starkeepConfigPath = resolve(REPO_ROOT, "starkeep-config.json");
  if (!existsSync(starkeepConfigPath)) {
    return NextResponse.json({ error: "starkeep-config.json not found — complete cloud setup first" }, { status: 400 });
  }
  const starkeepConfig = readFileSync(starkeepConfigPath, "utf-8");
  const stage = (JSON.parse(starkeepConfig) as { stage?: string }).stage ?? "starkeep";

  // Write starkeep-config.json to photos repo root so sst.config.ts can read it
  writeFileSync(resolve(expandedPath, "starkeep-config.json"), starkeepConfig);

  // Write the stage into .sst/stage so SST uses the right stage even if the file
  // was previously set to a different value (e.g. the system username default).
  const sstDir = resolve(infraPath, ".sst");
  mkdirSync(sstDir, { recursive: true });
  writeFileSync(resolve(sstDir, "stage"), stage);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_SESSION_TOKEN: credentials.sessionToken,
    AWS_REGION: credentials.region,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function emitLine(line: string) {
        if (line) controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
      }

      // Regenerate pnpm-workspace.yaml (and a minimal package.json root marker if absent)
      // in the user-configured workspace directory.
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

      // Install infra deps via workspace root if needed
      if (!existsSync(resolve(infraPath, "node_modules"))) {
        emitLine("Installing infra dependencies...");
        await new Promise<void>((resolve, reject) => {
          const install = spawn("pnpm", ["install"], {
            cwd: expandedWorkspace,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          install.stdout.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString().split("\n")) emitLine(line);
          });
          install.stderr.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString().split("\n")) emitLine(line);
          });
          install.on("close", (code) => code === 0 ? resolve() : reject(new Error(`pnpm install failed with exit code ${code}`)));
          install.on("error", reject);
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(msg)}\n\n`));
          controller.close();
          throw err;
        });
      }

      const child = spawn("pnpm", ["run", "deploy"], {
        cwd: infraPath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n")) emitLine(line); });
      child.stderr.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n")) emitLine(line); });

      child.on("close", (code) => {
        // On success, read the photos-cloud-config.json outputs the SST stack wrote
        let photosCloudConfig: Record<string, unknown> | null = null;
        if (code === 0) {
          const outputsPath = resolve(infraPath, "photos-cloud-config.json");
          if (existsSync(outputsPath)) {
            photosCloudConfig = JSON.parse(readFileSync(outputsPath, "utf-8")) as Record<string, unknown>;
          }
        }
        const donePayload = JSON.stringify({ exitCode: code ?? 1, photosCloudConfig });
        controller.enqueue(encoder.encode(`event: done\ndata: ${donePayload}\n\n`));
        controller.close();
      });

      child.on("error", (err) => {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`));
        controller.close();
      });
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
