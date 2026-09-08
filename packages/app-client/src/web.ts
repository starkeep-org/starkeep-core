/**
 * The platform's browser-facing shell adapter: `@starkeep/app-client/web`.
 *
 * Every Starkeep app that serves a browser needs the same six things in front
 * of whatever framework it chose, and none of the six is framework knowledge:
 *
 *   1. Strip the `/apps/<appId>` mount prefix the platform routes under.
 *   2. Convert an API Gateway v2 event to a web `Request` and back.
 *   3. Carry cookies across that conversion in both directions.
 *   4. Serve declared paths from a staged assets directory.
 *   5. Refuse a path that escapes that directory.
 *   6. Answer with `immutable` for content-addressed assets and
 *      `must-revalidate` for everything else.
 *
 * Memo, Photos and Probe each wrote their own copy of that list, and the copies
 * diverged: Probe handles `Set-Cookie` itself, Memo and Photos receive it from
 * OpenNext, and no two of the three would behave identically if swapped. This
 * module is the one copy, so a fix reaches every app that adopts it.
 *
 * What stays with the app is the short list the boundary in
 * `authoring-an-app.md` was reaching for: which framework, the build command
 * that produces its output, native dependencies, and **which of its public
 * paths are files on disk** — supplied here as data, and declared in the
 * manifest as `staticAssetPaths` so the platform can check it against
 * `publicPaths` rather than each app testing its own build script.
 *
 * The static branch runs *before* the upstream, so it runs before the app's own
 * gate. That makes `staticPaths` an enforcement bypass by construction, and it
 * is why the manifest refuses an entry that `publicPaths` does not already
 * cover.
 */

import { readFile, stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLambdaEntry, type UpstreamHandler } from "./lambda.js";

/** API Gateway v2, payload format 2.0 — the shape the platform's routes emit. */
export interface ApiGatewayV2Event {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

export interface ApiGatewayV2Result {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
}

/** An upstream that speaks API Gateway events, e.g. an OpenNext server function. */
export type EventUpstreamHandler = (
  event: ApiGatewayV2Event,
  context: unknown,
) => ApiGatewayV2Result | Promise<ApiGatewayV2Result>;

/**
 * An upstream that speaks web `Request`/`Response`.
 *
 * `path` is the app-relative path with the mount prefix already stripped. It is
 * passed alongside the request rather than rewritten into `request.url` so an
 * app that needs the origin-facing URL — building an absolute redirect, say —
 * still has it.
 */
export type RequestUpstreamHandler = (
  request: Request,
  path: string,
) => Response | Promise<Response>;

interface CommonOptions {
  /**
   * The platform mount prefix, e.g. `/apps/memo`. Empty when the app owns its
   * origin. Both the bare prefix and its trailing-slash spelling resolve to the
   * app root: API Gateway cannot register a route key holding an empty trailing
   * segment, so the bare prefix is the only spelling the platform can make
   * public, and a browser will produce the other.
   */
  basePath?: string;
  /**
   * Where the bundle staged its static files. A `file:` URL is accepted so a
   * caller can write `new URL("./assets/", import.meta.url)` without resolving
   * it first.
   */
  assetsDir?: string | URL;
  /**
   * The subset of the handler's `publicPaths` this bundle answers from disk,
   * read from the manifest rather than hand-written. Entries take the
   * `publicPaths` spelling: a literal path, or a `/prefix/*` glob.
   */
  staticPaths?: string[];
  /**
   * Which static paths are content-addressed, and therefore cacheable forever.
   * Defaults to `/_next/static/*` — the platform's own cache-behavior
   * convention, which the CloudFront distribution already names and which an
   * app using no framework at all still adopts.
   */
  immutablePaths?: string[];
  /**
   * What to answer when a declared static path names no file on disk.
   *
   *   - `"upstream"` (default) hands the request to the framework. Right
   *     wherever the framework claims sibling paths under the same prefix —
   *     Next serves `_next/data/*` from the server while `_next/static/*` is on
   *     disk, so a prefix-wide glob has to fall through.
   *   - `"notFound"` answers 404 here. Right for an app whose assets directory
   *     is the whole truth for the paths it declared.
   */
  staticMiss?: "upstream" | "notFound";
  /**
   * Turn a thrown upstream error into a response instead of letting it escape.
   *
   * Off by default, because a framework that already reports its own failures
   * should keep doing so. An app that would otherwise surface a bare 502 with
   * nothing in it to say what failed wants this.
   */
  onError?: (err: unknown, event: ApiGatewayV2Event) => ApiGatewayV2Result;
}

export interface EventUpstreamOptions extends CommonOptions {
  /**
   * The already-started import of the module exporting the upstream `handler`.
   * A promise, never a thunk — see `createLambdaEntry` for why.
   */
  upstream: Promise<{ handler: EventUpstreamHandler }>;
  requestUpstream?: never;
}

export interface RequestUpstreamOptions extends CommonOptions {
  /** The already-started import of the module exporting a `Request` handler. */
  requestUpstream: Promise<{ handler: RequestUpstreamHandler }>;
  upstream?: never;
}

export type WebAppHandlerOptions = EventUpstreamOptions | RequestUpstreamOptions;

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
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

const TEXT_EXT = new Set([
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".webmanifest",
  ".map",
  ".svg",
  ".txt",
  ".html",
  ".xml",
]);

const DEFAULT_IMMUTABLE_PATHS = ["/_next/static/*"];

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
 * `staticAssetPaths` and `publicPaths`, so the allow-list the adapter applies
 * and the one the installer checks cannot mean different things.
 */
export function pathCoveredBy(entry: string, path: string): boolean {
  if (entry.endsWith("/*")) {
    const bare = entry.slice(0, -2);
    return path === bare || path.startsWith(`${bare}/`);
  }
  return path === entry;
}

function coveredByAny(entries: string[], path: string): boolean {
  return entries.some((entry) => pathCoveredBy(entry, path));
}

/**
 * The app-relative path for a raw gateway path, with the mount prefix removed.
 *
 * Returns null when the path does not sit under the prefix at all, which is a
 * request the platform should never have routed here.
 */
export function stripBasePath(basePath: string, rawPath: string): string | null {
  if (!basePath) return rawPath || "/";
  if (rawPath === basePath) return "/";
  if (rawPath === `${basePath}/`) return "/";
  if (rawPath.startsWith(`${basePath}/`)) return rawPath.slice(basePath.length) || "/";
  return null;
}

/** Build a web Request from the event, preserving the body and the cookie jar. */
export function toRequest(event: ApiGatewayV2Event, fallbackHost = "app.invalid"): Request {
  const method = event.requestContext?.http?.method ?? "GET";
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (v !== undefined) headers.set(k, v);
  }
  // API Gateway v2 lifts cookies out of the headers into their own array, and
  // every session library reads the `Cookie` header, so put them back.
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));

  const host = headers.get("host") ?? fallbackHost;
  const proto = headers.get("x-forwarded-proto") ?? "https";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `${proto}://${host}${event.rawPath ?? "/"}${query}`;

  const hasBody = event.body !== undefined && method !== "GET" && method !== "HEAD";
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body!, "base64")
      : Buffer.from(event.body!, "utf8")
    : undefined;

  return new Request(url, { method, headers, ...(body ? { body } : {}) });
}

/**
 * Serialize a web Response into the event result.
 *
 * `Set-Cookie` moves to the `cookies` array rather than staying in `headers`: a
 * plain headers map holds one value per name, so a sign-in setting both a
 * session and a token cookie would lose one of them.
 */
export async function toResult(res: Response): Promise<ApiGatewayV2Result> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    headers[key] = value;
  });
  for (const c of res.headers.getSetCookie()) cookies.push(c);

  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "";
  const isText = /^text\/|json|javascript|xml/i.test(contentType);
  return {
    statusCode: res.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: isText ? buf.toString("utf8") : buf.toString("base64"),
    ...(isText ? {} : { isBase64Encoded: true }),
  };
}

function resolveAssetsDir(dir: string | URL | undefined): string | null {
  if (dir === undefined) return null;
  if (dir instanceof URL) return fileURLToPath(dir).replace(/[/\\]+$/, "");
  return dir.startsWith("file:")
    ? fileURLToPath(dir).replace(/[/\\]+$/, "")
    : dir.replace(/[/\\]+$/, "");
}

/**
 * Answer an app-relative path from the assets directory, or null on a miss.
 *
 * `normalize()` collapses any `../` segments before the filesystem is touched;
 * anything that still escapes the directory afterwards is refused rather than
 * read. A directory is a miss, not a listing.
 */
async function serveAsset(
  assetsDir: string,
  path: string,
  immutable: boolean,
): Promise<ApiGatewayV2Result | null> {
  const rest = path.replace(/^\/+/, "");
  const filePath = join(assetsDir, normalize(rest));
  if (filePath !== assetsDir && !filePath.startsWith(assetsDir + sep)) {
    return { statusCode: 400, headers: { "content-type": "text/plain" }, body: "Bad path" };
  }
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error("Static asset read error:", err);
    }
    return null;
  }

  const ct = contentTypeFor(filePath);
  const dot = filePath.lastIndexOf(".");
  const ext = dot < 0 ? "" : filePath.slice(dot).toLowerCase();
  const cacheControl = immutable
    ? "public, max-age=31536000, immutable"
    : "public, max-age=0, must-revalidate";
  const headers = { "content-type": ct, "cache-control": cacheControl };

  if (TEXT_EXT.has(ext)) {
    return { statusCode: 200, headers, body: await readFile(filePath, "utf8") };
  }
  const buf = await readFile(filePath);
  return { statusCode: 200, headers, body: buf.toString("base64"), isBase64Encoded: true };
}

/**
 * Build the Lambda handler for a browser-facing app.
 *
 * ```js
 * export const handler = await createWebAppHandler({
 *   basePath: process.env.STARKEEP_APP_BASE_PATH,
 *   assetsDir: new URL("./assets/", import.meta.url),
 *   staticPaths: staticHandler.staticAssetPaths,
 *   upstream: import("./app/index.mjs"),
 * });
 * ```
 *
 * The upstream import is awaited here, during INIT, because this composes with
 * `createLambdaEntry` rather than reimplementing it. An app that adopts the web
 * adapter therefore gets the INIT guarantee without having to know the
 * invariant exists.
 */
export async function createWebAppHandler(
  opts: WebAppHandlerOptions,
): Promise<(event: ApiGatewayV2Event, context?: unknown) => Promise<ApiGatewayV2Result>> {
  const basePath = (opts.basePath ?? "").replace(/\/+$/, "");
  const assetsDir = resolveAssetsDir(opts.assetsDir);
  const staticPaths = opts.staticPaths ?? [];
  const immutablePaths = opts.immutablePaths ?? DEFAULT_IMMUTABLE_PATHS;
  const staticMiss = opts.staticMiss ?? "upstream";

  if (staticPaths.length > 0 && !assetsDir) {
    throw new Error(
      `Starkeep web adapter: staticPaths declares ${staticPaths.length} path(s) served from ` +
        `disk but no assetsDir was given, so every one of them would fall through. Pass ` +
        `assetsDir, or declare no staticAssetPaths in the manifest.`,
    );
  }

  const isEventUpstream = opts.upstream !== undefined;
  const upstream = await createLambdaEntry({
    upstream: (opts.upstream ?? opts.requestUpstream) as Promise<{ handler: UpstreamHandler }>,
    label: isEventUpstream ? "the app's Lambda upstream" : "the app's request upstream",
  });

  async function callUpstream(
    event: ApiGatewayV2Event,
    context: unknown,
    path: string,
  ): Promise<ApiGatewayV2Result> {
    if (isEventUpstream) {
      // The original event, prefix intact: a framework built with the mount
      // prefix baked in reasons in the platform's terms, not the app's.
      return await (upstream as unknown as EventUpstreamHandler)(event, context);
    }
    const res = await (upstream as unknown as RequestUpstreamHandler)(toRequest(event), path);
    return await toResult(res);
  }

  return async function handler(
    event: ApiGatewayV2Event,
    context?: unknown,
  ): Promise<ApiGatewayV2Result> {
    const rawPath = event?.rawPath ?? "/";
    const path = stripBasePath(basePath, rawPath) ?? rawPath;
    try {
      if (assetsDir && coveredByAny(staticPaths, path)) {
        const served = await serveAsset(assetsDir, path, coveredByAny(immutablePaths, path));
        if (served) return served;
        if (staticMiss === "notFound") {
          return {
            statusCode: 404,
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: "Not found",
          };
        }
      }
      return await callUpstream(event, context, path);
    } catch (err) {
      if (opts.onError) return opts.onError(err, event);
      throw err;
    }
  };
}
