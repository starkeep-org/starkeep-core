/**
 * The platform's static-file responder, shared by both surfaces.
 *
 * The cloud adapter (`createWebAppHandler` in `./web.ts`) and the local
 * surface's Hono middleware (`serveStatic` in `./hono.ts`) both answer an app's
 * declared static paths through this one function. Before it existed, the cloud
 * adapter held the rules and every app wrote its own local file server, and the
 * local copies disagreed with the cloud on content types, client-route fallback
 * and cache headers. An app could then work on one surface and break on the
 * other. One responder means one set of rules:
 *
 *   - Serve only the paths the manifest declared (`staticAssetPaths`).
 *   - Refuse a path that escapes the assets directory.
 *   - Name the content type from the file's extension, defaulting to bytes.
 *   - Cache `immutablePaths` forever and revalidate everything else, with an
 *     `ETag` so a revalidation costs a 304 rather than the whole file.
 *   - Answer a declared client route with the SPA shell.
 *
 * Every function here returns a web `Response`, so the module knows nothing
 * about API Gateway or Hono. Each surface converts at its own edge.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MIME: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  // `WebAssembly.instantiateStreaming()` rejects any other type, and a loader
  // without a buffer fallback then fails outright. Flutter's web output ships
  // WebAssembly, which is how this entry's absence was found.
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/** The SPA shell's file name inside `assetsDir`, when `shellPaths` is declared. */
export const DEFAULT_SHELL_FILE = "index.html";

/** Cache-Control for a content-addressed file: the bytes at this path never change. */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Cache-Control for every other static file: keep it, but ask before reusing it. */
export const REVALIDATE_CACHE_CONTROL = "public, max-age=0, must-revalidate";

/** The content type for a file, defaulting to bytes rather than to a guess. */
export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Does a `publicPaths`-style entry cover this app-relative path?
 *
 * `/x/*` covers `/x` and everything under `/x/`; a literal entry covers only
 * itself. The same relation the manifest schema enforces between
 * `staticAssetPaths` and `publicPaths`, so the allow-list the responder applies
 * and the one the installer checks cannot mean different things.
 */
export function pathCoveredBy(entry: string, path: string): boolean {
  if (entry.endsWith("/*")) {
    const bare = entry.slice(0, -2);
    return path === bare || path.startsWith(`${bare}/`);
  }
  return path === entry;
}

export function coveredByAny(entries: string[], path: string): boolean {
  return entries.some((entry) => pathCoveredBy(entry, path));
}

/** An assets directory given as a path or a `file:` URL, without its trailing slash. */
export function resolveAssetsDir(dir: string | URL | undefined): string | null {
  if (dir === undefined) return null;
  if (dir instanceof URL) return fileURLToPath(dir).replace(/[/\\]+$/, "");
  return dir.startsWith("file:")
    ? fileURLToPath(dir).replace(/[/\\]+$/, "")
    : dir.replace(/[/\\]+$/, "");
}

export interface StaticResponderOptions {
  /** The build output directory, as a path or a `file:` URL. */
  assetsDir: string | URL;
  /**
   * The paths this app answers from disk: the handler's `staticAssetPaths`
   * from the manifest. Entries take the `publicPaths` spelling, a literal path
   * or a `/prefix/*` glob.
   */
  staticPaths: string[];
  /**
   * Which static paths are content-addressed, and therefore cacheable forever.
   * Required for the same reason `createWebAppHandler` requires it: a default
   * would decide an app's cache headers on the app's behalf. Pass
   * `["/_immutable/*"]`, or `[]` for a build that hashes nothing.
   */
  immutablePaths: string[];
  /** The app's client routes, answered with the shell. See `createWebAppHandler`. */
  shellPaths?: string[];
  /** The shell file inside `assetsDir`. Defaults to `index.html`. */
  shellFile?: string;
  /**
   * What a declared static path with no file on disk answers: `"upstream"`
   * (the default) returns null so the caller hands the request to the app, and
   * `"notFound"` answers 404 here.
   */
  staticMiss?: "upstream" | "notFound";
}

/**
 * Answers a request from disk, or returns null to say "not a static file".
 *
 * `path` is the app-relative path, with any mount prefix already removed. The
 * request supplies the method and `If-None-Match`.
 */
export type StaticResponder = (request: Request, path: string) => Promise<Response | null>;

interface CachedTag {
  mtimeMs: number;
  size: number;
  etag: string;
}

/**
 * Build the responder.
 *
 * Throws when the assets directory is missing or when `shellPaths` is declared
 * with no assets directory to read the shell from, because either mistake would
 * otherwise read as a blank page in a browser rather than as a startup error.
 */
export function createStaticResponder(opts: StaticResponderOptions): StaticResponder {
  const assetsDir = resolveAssetsDir(opts.assetsDir);
  if (!assetsDir) throw new Error("Starkeep static responder: assetsDir is required.");
  const staticPaths = opts.staticPaths;
  const immutablePaths = opts.immutablePaths;
  const shellPaths = opts.shellPaths ?? [];
  const shellFile = opts.shellFile ?? DEFAULT_SHELL_FILE;
  const staticMiss = opts.staticMiss ?? "upstream";

  // A file's tag is a hash of its bytes, kept while its size and mtime hold.
  // Files do not change under a running process in either surface's normal
  // use, so the cache mostly saves re-hashing on every revalidation, and the
  // stat check keeps a rebuild during local development honest.
  const tags = new Map<string, CachedTag>();

  async function serveFile(
    request: Request,
    path: string,
    immutable: boolean,
  ): Promise<Response | null> {
    const rest = path.replace(/^\/+/, "");
    const filePath = join(assetsDir!, normalize(rest));
    if (filePath !== assetsDir && !filePath.startsWith(assetsDir + sep)) {
      return new Response("Bad path", {
        status: 400,
        headers: { "content-type": "text/plain" },
      });
    }

    let size: number;
    let mtimeMs: number;
    try {
      const s = await stat(filePath);
      if (!s.isFile()) return null;
      size = s.size;
      mtimeMs = s.mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error("Static asset read error:", err);
      }
      return null;
    }

    const headers: Record<string, string> = {
      "content-type": contentTypeFor(filePath),
      "cache-control": immutable ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL,
    };

    const cached = tags.get(filePath);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
      headers.etag = cached.etag;
      if (etagMatches(request.headers.get("if-none-match"), cached.etag)) {
        return new Response(null, { status: 304, headers });
      }
    }

    const body = await readFile(filePath);
    const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
    tags.set(filePath, { mtimeMs, size, etag });
    headers.etag = etag;
    if (etagMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
  }

  return async function respond(request, path) {
    if (coveredByAny(staticPaths, path)) {
      const served = await serveFile(request, path, coveredByAny(immutablePaths, path));
      if (served) return served;
      if (staticMiss === "notFound") {
        return new Response("Not found", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    // The SPA shell, after the file branch and before the app: a client route
    // has no file of its own, and the app half has no page to answer it with.
    // A missing shell returns null rather than 404ing, so a build that never
    // ran reads as "the app answered" rather than as a routing bug.
    if (coveredByAny(shellPaths, path)) {
      const shell = await serveFile(request, `/${shellFile}`, false);
      if (shell) return shell;
    }
    return null;
  };
}

/** Does an `If-None-Match` header name this tag? Handles lists, `*` and weak tags. */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .includes(etag);
}
