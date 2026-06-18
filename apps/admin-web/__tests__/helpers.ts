/**
 * Shared helpers for admin-web API-route tests (Tier 1, plan §5 + §8).
 *
 * The route modules capture STARKEEP_DATA_DIR / STARKEEP_LOCAL_DATA_SERVER_URL
 * at module load, so every test file must set the env vars *before* importing
 * a route (dynamic import inside beforeAll). Vitest isolates test files in
 * separate workers, so per-file env doesn't leak.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

/** Temp dir to act as STARKEEP_DATA_DIR (config.json, app-creds/, pids/). */
export function makeDataDir(prefix = "adminweb-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write `<dataDir>/config.json` (what app-scan and the config route read). */
export function writeAdminConfig(dataDir: string, config: Record<string, unknown>): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config, null, 2));
}

/**
 * Create `<parentDir>/<dirName>` containing a starkeep.manifest.json. Pass a
 * string to write raw (malformed) content. Returns the app dir.
 */
export function makeAppDir(
  parentDir: string,
  dirName: string,
  manifest: Record<string, unknown> | string,
): string {
  const appDir = join(parentDir, dirName);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, "starkeep.manifest.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2),
  );
  return appDir;
}

/** Minimal manifest that passes the local-data-server's validator. */
export function testAppManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "testapp",
    name: "Test App",
    version: "1.0.0",
    tier: "community",
    infraRequirements: {
      fileAccess: [
        { types: ["image/jpeg", "image/png"], access: "readwrite", metadataWrite: true, rationale: "test" },
      ],
    },
    ...over,
  };
}

/** Build a NextRequest with a JSON body for invoking POST/PATCH handlers. */
export function jsonRequest(
  path: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST",
): NextRequest {
  // `duplex` is required by undici when an init body is present.
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    duplex: "half",
  });
}

export function getRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

/**
 * Spawn a detached do-nothing node process (its own process group, like the
 * daemons admin-web spawns) to stand in for a running app dev server.
 */
export function spawnIdleProcess(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `fn` stops throwing, or fail after `timeoutMs`. */
export async function eventually<T>(
  fn: () => Promise<T> | T,
  { timeoutMs = 15_000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (Date.now() > deadline) throw lastError;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
