/**
 * What the built client answers, decided without starting anything.
 *
 * Its own module rather than part of `src/server.ts`, because `server.ts` is a
 * process entry: importing it binds a port. The decision is the part worth
 * testing, and the order it makes is the part worth pinning — a real file wins
 * over the shell, which is the same precedence the platform's web adapter
 * applies to a deployed app.
 */

import { statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DIST_DIR = join(PKG_DIR, "dist");
export const SHELL = join(DIST_DIR, "index.html");

/**
 * Drive's client routes. One screen, so one entry — and it is a list rather
 * than a blanket fallback so an undeclared path 404s instead of quietly
 * rendering the app under a URL nothing serves.
 */
export const CLIENT_ROUTES = ["/"];

const MIME: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Is this path the server's rather than the client's? */
export function isServerPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function isClientRoute(pathname: string): boolean {
  return CLIENT_ROUTES.includes(pathname);
}

/** What the built client answers a path with. */
export type ClientAnswer =
  | { kind: "asset"; file: string; contentType: string; cacheControl: string }
  | { kind: "shell"; file: string }
  | { kind: "notFound" };

export function resolveClientRequest(pathname: string): ClientAnswer {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is not a path; it is certainly not a file.
    return { kind: "notFound" };
  }
  const candidate = join(DIST_DIR, normalize(decoded));
  // Containment first: a `..` that climbed out of the build must not be read,
  // whatever it points at.
  //
  // `isFile`, not "exists": `/` joins to the build directory itself, and
  // reading a directory throws EISDIR — which would be a 500 on the app's own
  // front page, where the shell is the answer.
  if (candidate.startsWith(DIST_DIR + sep) && isFile(candidate)) {
    const dot = candidate.lastIndexOf(".");
    return {
      kind: "asset",
      file: candidate,
      contentType: MIME[candidate.slice(dot).toLowerCase()] ?? "application/octet-stream",
      // Content-hashed output is cacheable forever; everything else must
      // revalidate, because the shell is the one file whose contents change
      // while its name does not. The same split the platform's web adapter
      // applies to a deployed bundle, which is why the prefix matches.
      cacheControl: pathname.startsWith("/_immutable/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    };
  }
  if (isClientRoute(pathname)) return { kind: "shell", file: SHELL };
  return { kind: "notFound" };
}
