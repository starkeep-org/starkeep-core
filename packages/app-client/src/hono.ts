/**
 * The platform's Hono integration: `@starkeep/app-client/hono`.
 *
 * A Starkeep app's server half is a Hono app. This module holds the two joints
 * between Hono and the platform, so every app settles them the same way:
 *
 *   1. **Where the mount prefix goes.** `createWebAppHandler` hands an upstream
 *      `(request, path)` — the request as the origin saw it, plus the
 *      app-relative path with `/apps/<appId>` already stripped
 *      (`RequestUpstreamHandler` in `./web.ts`). Hono routes on the request's
 *      own pathname, which still carries the prefix. `honoUpstream` resolves
 *      that by rewriting the URL to the app-relative path before calling
 *      `app.fetch`, so **app code never sees the mount**. An app route is
 *      written `/api/records` and matches on both surfaces.
 *   2. **The origin gate.** `honoOriginGate` is `createOriginGate` as Hono
 *      middleware, mounted with `app.use("*", ...)`.
 *
 * The alternative resolution for (1) was for each app to call
 * `app.basePath(process.env.STARKEEP_APP_BASE_PATH)`. It is rejected because it
 * puts the mount in four app repositories rather than in one platform module,
 * and because the mount is a platform fact: the installer chooses it, and an
 * app that hard-codes a matching prefix is a second copy of that choice.
 *
 * An app that genuinely needs the origin-facing URL — building an absolute
 * redirect, printing a link — reads the mount from `appBasePath()` rather than
 * from the request. That is the same environment variable the installer writes
 * on the Lambda, so it is the one place the mount is stated.
 *
 * Nothing here imports Hono. The two Hono shapes this module touches — an app
 * with a `fetch`, and a middleware `(c, next)` — are structural, so the
 * integration adds no dependency to an app's Lambda bundle and this module
 * stays importable from a test that has no Hono installed.
 */

import { createOriginGate, type AuthGateOptions } from "./edge.js";
import type { RequestUpstreamHandler } from "./web.js";

/** The `fetch` half of a Hono app — all the adapter needs from one. */
export interface FetchApp {
  fetch: (request: Request, ...rest: never[]) => Response | Promise<Response>;
}

/**
 * The app's mount prefix, e.g. `/apps/photos`, or `""` on the local surface
 * where the app owns its origin.
 *
 * `STARKEEP_APP_BASE_PATH` is written by the installer onto the app's Lambda
 * (`admin-installer/scripts/cli-install-app.ts`), so this reads the platform's
 * own statement of the mount rather than a copy of it.
 */
export function appBasePath(): string {
  return (process.env.STARKEEP_APP_BASE_PATH ?? "").replace(/\/+$/, "");
}

/**
 * Adapt a Hono app to `createWebAppHandler`'s `requestUpstream`.
 *
 * ```js
 * export const handler = await createWebAppHandler({
 *   basePath: process.env.STARKEEP_APP_BASE_PATH,
 *   requestUpstream: import("./app.js").then((m) => ({ handler: honoUpstream(m.app) })),
 * });
 * ```
 *
 * The rewrite is a new `Request` around the same method, headers, body and
 * signal, because a `Request`'s URL is read-only. When the path already equals
 * the request's pathname — the local surface, where there is no prefix — the
 * original request is passed straight through, so the common case allocates
 * nothing and a body is never re-wrapped.
 */
export function honoUpstream(app: FetchApp): RequestUpstreamHandler {
  return (request, path) => app.fetch(rewritePath(request, path));
}

/**
 * The same rewrite, exposed for a local server that dispatches to Hono itself.
 *
 * `@hono/node-server` hands the app a request whose URL is the origin's, which
 * is already app-relative on the local surface. An app that mounts itself under
 * a prefix locally — nothing does today — runs its requests through here first.
 */
export function rewritePath(request: Request, path: string): Request {
  const url = new URL(request.url);
  if (url.pathname === path) return request;
  url.pathname = path;
  // `duplex` is required by undici whenever an init carries a body, and a
  // request's body is always a stream. GET and HEAD have no body to carry.
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    ...(hasBody ? { body: request.body, duplex: "half" } : {}),
  } as RequestInit);
}

/** The Hono context fields the gate reads. Structural, so Hono stays unimported. */
interface GateContext {
  req: { raw: Request };
  res: Response;
}

/**
 * The origin gate as Hono middleware: `app.use("*", honoOriginGate({ ... }))`.
 *
 * Deny-by-default over the manifest's `publicPaths`, exactly as
 * `createOriginGate` describes it. Inert on the local surface, where the app
 * owns the machine and gating on-device data behind a sign-in would break the
 * local-first guarantee.
 *
 * Mount it before the routes. `publicPaths` entries are written app-relative —
 * the spelling the manifest uses — because `honoUpstream` has already rewritten
 * the request's URL by the time the gate sees it.
 *
 * **`basePath` defaults to `appBasePath()` here, and that default is
 * load-bearing.** `createOriginGate` uses `basePath` for two jobs: stripping the
 * mount off the pathname it matches, and prefixing the sign-in path in the
 * `Location` it redirects to. Under this mount the first job is already done and
 * the option would look unnecessary — but the second is not, and a gate left
 * with an empty `basePath` sends a signed-out browser to `/sign-in` at the
 * distribution root, which is outside the app and belongs to nobody. The
 * stripping stays a no-op because the pathname no longer carries the prefix, so
 * one value serves both. Pass `basePath` explicitly only to override it.
 */
export function honoOriginGate(
  opts: AuthGateOptions,
): (c: GateContext, next: () => Promise<void>) => Promise<void> {
  const gate = createOriginGate({ ...opts, basePath: opts.basePath ?? appBasePath() });
  return async (c, next) => {
    const refused = gate(c.req.raw);
    if (refused) {
      c.res = refused;
      return;
    }
    await next();
  };
}
