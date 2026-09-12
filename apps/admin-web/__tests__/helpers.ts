/**
 * Shared helpers for admin-web API-route tests (Tier 1, plan §5 + §8).
 *
 * The route modules capture STARKEEP_DIR / STARKEEP_LOCAL_DATA_SERVER_URL
 * at module load, so every test file must set the env vars *before* importing
 * a route (dynamic import inside beforeAll). Vitest isolates test files in
 * separate workers, so per-file env doesn't leak.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

/**
 * A route handler as this suite holds it: plain `Request` in, plain `Response`
 * out, and the route's own context argument when it has one.
 *
 * The routes still annotate `NextRequest`/`NextResponse`, which is wider than
 * anything they use — every handler here touches only `json()`, `text()`,
 * `headers` and, in one case, `nextUrl`. `asRouteHandler` is the single place
 * that acknowledges those annotations, so the tests are written against the web
 * types and survive the routes dropping the framework ones.
 */
type UncheckedRouteHandler = (
  req: never,
  ...rest: never[]
) => Response | Promise<Response>;

export type RouteHandler<C = never> = (req: Request, ctx?: C) => Promise<Response>;

export function asRouteHandler<C = never>(handler: UncheckedRouteHandler): RouteHandler<C> {
  return handler as unknown as RouteHandler<C>;
}

/** Temp dir to act as STARKEEP_DIR (config.json, app-creds/, pids/). */
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

/** Build a request with a JSON body for invoking POST/PATCH/PUT/DELETE handlers. */
export function jsonRequest(
  path: string,
  body: unknown,
  method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST",
): Request {
  // `duplex` is required by undici when an init body is present.
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    duplex: "half",
  } as RequestInit);
}

/** A plain GET request. */
export function getRequest(path: string): Request {
  return new Request(`http://localhost${path}`);
}

/**
 * A GET request the daemon-status route can read a query string from.
 *
 * That route is the one handler in the app that reaches past the web `Request`
 * — it reads `req.nextUrl.searchParams` rather than parsing `req.url` — so it
 * is the one place a test has to hand it the framework's request. Everything
 * else in this suite uses `getRequest`.
 */
export function nextUrlRequest(path: string): Request {
  return new NextRequest(`http://localhost${path}`);
}

/**
 * A throwaway HTTP server standing in for the local-data-server.
 *
 * The proxy routes are thin, and what they are worth testing for is exactly
 * what a stub can show: which upstream path they call, whether they pass the
 * status and body through, and what they answer when the upstream is not
 * there. A real data server would test the data server.
 */
export interface StubServer {
  url: string;
  /** Every request the routes made, in order. */
  seen: Array<{ method: string; url: string; body: string }>;
  stop(): Promise<void>;
}

export async function startStubServer(
  respond: (req: { method: string; url: string; body: string }) => {
    status?: number;
    body?: string;
    contentType?: string;
  },
): Promise<StubServer> {
  const { createServer } = await import("node:http");
  const seen: StubServer["seen"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const seenReq = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        body: Buffer.concat(chunks).toString("utf-8"),
      };
      seen.push(seenReq);
      const out = respond(seenReq);
      res.writeHead(out.status ?? 200, {
        "Content-Type": out.contentType ?? "application/json",
      });
      res.end(out.body ?? "{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("stub server has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
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
