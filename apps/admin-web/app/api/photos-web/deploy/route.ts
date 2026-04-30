import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, dirname, relative, resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";
import type { STSCredentials } from "../../../../src/lib/cognito-auth";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
};
const TEXT_EXTS = new Set([".html", ".js", ".css", ".json", ".map", ".svg", ".txt"]);

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  emit: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n")) emit(line); });
    child.stderr.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n")) emit(line); });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)));
    child.on("error", reject);
  });
}

async function buildFrontend(
  photosWebPath: string,
  photosApiGatewayUrl: string,
  starkeepCfg: { region?: string; userPoolId?: string; userPoolClientId?: string; identityPoolId?: string; apiGatewayUrl?: string; auroraEndpoint?: string; s3Bucket?: string; s3Region?: string },
  env: NodeJS.ProcessEnv,
  emit: (line: string) => void,
): Promise<void> {
  emit("Building photos-web frontend...");
  for (const dir of [".next", "out"]) {
    const p = resolve(photosWebPath, dir);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  // Write a cloud-only runtime config — omit localDataServerUrl so the deployed
  // app never tries to reach localhost. readCloudConfig() looks for `apiGatewayUrl`
  // (not `photosApiGatewayUrl`), so map the field name correctly.
  const cloudRuntimeConfig = {
    // apiGatewayUrl = user-data gateway (handles /data/records, /data/files, etc.)
    apiGatewayUrl: starkeepCfg.apiGatewayUrl ?? "",
    // photosApiGatewayUrl = photos-specific gateway (handles /data/generate only)
    photosApiGatewayUrl: photosApiGatewayUrl,
    region: starkeepCfg.region ?? "",
    userPoolId: starkeepCfg.userPoolId ?? "",
    userPoolClientId: starkeepCfg.userPoolClientId ?? "",
    identityPoolId: starkeepCfg.identityPoolId ?? "",
    auroraEndpoint: starkeepCfg.auroraEndpoint ?? "",
    s3Bucket: starkeepCfg.s3Bucket ?? "",
    s3Region: starkeepCfg.s3Region ?? starkeepCfg.region ?? "",
  };
  writeFileSync(
    resolve(photosWebPath, "public/starkeep-runtime-config.json"),
    JSON.stringify(cloudRuntimeConfig, null, 2),
  );
  await runCmd("pnpm", ["build"], photosWebPath, {
    ...env,
    NODE_ENV: "production",
    NEXT_PUBLIC_FORCE_REMOTE: "true",
    NEXT_PUBLIC_API_GATEWAY_URL: photosApiGatewayUrl,
    NEXT_PUBLIC_COGNITO_REGION: starkeepCfg.region ?? "",
    NEXT_PUBLIC_COGNITO_USER_POOL_ID: starkeepCfg.userPoolId ?? "",
    NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID: starkeepCfg.userPoolClientId ?? "",
  }, emit);

  const outDir = resolve(photosWebPath, "out");
  const assets: Record<string, { content: string; isBase64: boolean; contentType: string }> = {};
  for (const absPath of walkDir(outDir)) {
    const relPath = absPath.slice(outDir.length).replace(/\\/g, "/");
    const ext = extname(absPath).toLowerCase();
    const isText = TEXT_EXTS.has(ext);
    const buf = readFileSync(absPath);
    assets[relPath] = {
      content: isText ? buf.toString("utf-8") : buf.toString("base64"),
      isBase64: !isText,
      contentType: MIME[ext] ?? "application/octet-stream",
    };
  }
  const webAssetsPath = resolve(photosWebPath, "infra/src/web-assets.json");
  writeFileSync(webAssetsPath, JSON.stringify(assets));
  emit(`Generated web-assets.json (${Object.keys(assets).length} files)`);
}

function readPhotosCloudConfig(infraPath: string): Record<string, unknown> | null {
  // Prefer infra/photos-cloud-config.json (written by the fixed sst.config.ts).
  // Fall back to .sst/platform/ for deployments made before the path fix.
  const rootPath = resolve(infraPath, "photos-cloud-config.json");
  const sstPlatformPath = resolve(infraPath, ".sst/platform/photos-cloud-config.json");
  for (const p of [rootPath, sstPlatformPath]) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>; } catch { /* ignore */ }
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  const photosWebPath = req.nextUrl.searchParams.get("path");
  if (!photosWebPath) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  const expandedPath = photosWebPath.replace(/^~/, process.env.HOME ?? "");
  const infraPath = resolve(expandedPath, "infra");
  const photosCloudConfig = readPhotosCloudConfig(infraPath);
  return NextResponse.json({ deployed: photosCloudConfig !== null, photosCloudConfig });
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
  const expandedWorkspace = dirname(expandedPath);
  const infraPath = resolve(expandedPath, "infra");

  if (!existsSync(infraPath)) {
    return NextResponse.json({ error: `infra directory not found at ${infraPath}` }, { status: 400 });
  }

  const starkeepConfigPath = resolve(REPO_ROOT, "starkeep-config.json");
  if (!existsSync(starkeepConfigPath)) {
    return NextResponse.json({ error: "starkeep-config.json not found — complete cloud setup first" }, { status: 400 });
  }
  const starkeepConfigRaw = readFileSync(starkeepConfigPath, "utf-8");
  const starkeepCfg = JSON.parse(starkeepConfigRaw) as {
    stage?: string;
    region?: string;
    userPoolId?: string;
    userPoolClientId?: string;
    identityPoolId?: string;
    apiGatewayUrl?: string;
    auroraEndpoint?: string;
    s3Bucket?: string;
    s3Region?: string;
  };
  const stage = starkeepCfg.stage ?? "starkeep";

  writeFileSync(resolve(expandedPath, "starkeep-config.json"), starkeepConfigRaw);

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
        if (line.trim()) controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
      }

      try {
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

        if (!existsSync(resolve(infraPath, "node_modules"))) {
          emitLine("Installing dependencies...");
          await runCmd("pnpm", ["install"], expandedWorkspace, env, emitLine);
        }

        // If the API gateway URL is already known from a prior deploy, build the
        // frontend assets now so the static-server Lambda gets included this deploy.
        const priorConfig = readPhotosCloudConfig(infraPath);
        const priorApiUrl = typeof priorConfig?.photosApiGatewayUrl === "string"
          ? priorConfig.photosApiGatewayUrl : null;

        if (priorApiUrl) {
          await buildFrontend(expandedPath, priorApiUrl, starkeepCfg, env, emitLine);
        }

        emitLine("Deploying to AWS...");
        await runCmd("pnpm", ["run", "deploy"], infraPath, env, emitLine);

        let photosCloudConfig = readPhotosCloudConfig(infraPath);

        // First-ever deploy: API gateway URL is now available for the first time.
        // Build the frontend and re-deploy so the static-server Lambda is included.
        if (!priorApiUrl) {
          const freshApiUrl = typeof photosCloudConfig?.photosApiGatewayUrl === "string"
            ? photosCloudConfig.photosApiGatewayUrl : null;
          if (freshApiUrl) {
            await buildFrontend(expandedPath, freshApiUrl, starkeepCfg, env, emitLine);
            emitLine("Re-deploying with frontend assets...");
            await runCmd("pnpm", ["run", "deploy"], infraPath, env, emitLine);
            photosCloudConfig = readPhotosCloudConfig(infraPath);
          }
        }

        const donePayload = JSON.stringify({ exitCode: 0, photosCloudConfig });
        controller.enqueue(encoder.encode(`event: done\ndata: ${donePayload}\n\n`));
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
