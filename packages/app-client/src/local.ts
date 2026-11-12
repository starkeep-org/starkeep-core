/**
 * `@starkeep/app-client/local`: an app's whole local server in one call.
 *
 * ```ts
 * import { serveLocal } from "@starkeep/app-client/local";
 * import { app } from "./app.js";
 *
 * serveLocal({
 *   app,
 *   static: staticOptions(new URL("../../dist/", import.meta.url)),
 * });
 * ```
 *
 * `serveLocal` makes the four choices every local server must make the same
 * way, so an app cannot get one wrong:
 *
 * 1. It reads the port admin-web chose from `--port <n>`, or from `PORT`.
 * 2. It binds `127.0.0.1`, which keeps other devices out.
 * 3. It refuses, before any route runs, a request with a non-loopback `Host`
 *    and a request a page on another site sent (`./local-guard.ts`).
 * 4. It answers static paths with the platform's static responder, the one the
 *    cloud adapter runs, ahead of the app's routes, as the cloud does.
 *
 * Everything else goes to the app's own `fetch`. The app's routes, the signing
 * proxy included, never see a request the guard refused.
 *
 * Needs `@hono/node-server`, an optional peer dependency of this package.
 */
import { serve, type ServerType } from "@hono/node-server";
import { localRequestRefusal } from "./local-guard.js";
import { createStaticResponder, type StaticResponderOptions } from "./static.js";

/** The address every local app server binds. */
export const LOCAL_LISTEN_HOST = "127.0.0.1";

export interface ServeLocalOptions {
  /** The app: anything with a web-standard `fetch`, such as a Hono app. */
  app: { fetch: (request: Request) => Response | Promise<Response> };
  /**
   * The options the cloud adapter's static branch takes, with `assetsDir`
   * pointing at the local build. Omit for an app that serves no files.
   */
  static?: StaticResponderOptions;
  /** The port to listen on. Defaults to `--port <n>` in `argv`, then `PORT`. */
  port?: number;
  /** The arguments to read `--port` from. Defaults to `process.argv`. */
  argv?: readonly string[];
  /** Called once the server listens. Defaults to one log line. */
  onListen?: (info: { port: number; url: string }) => void;
}

/** The port admin-web passed: `--port <n>`, then `PORT`. */
export function localPort(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const at = argv.indexOf("--port");
  const raw = at >= 0 ? argv[at + 1] : env.PORT;
  const port = Number(raw);
  if (raw === undefined || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("A local app server needs a port: --port <n>. admin-web passes one.");
  }
  return port;
}

/**
 * The local server's request handler, without the listening socket: guard,
 * then static files, then the app. `serveLocal` serves this; tests call it
 * directly.
 */
export function localFetch(
  opts: Pick<ServeLocalOptions, "app" | "static">,
): (request: Request) => Promise<Response> {
  const respond = opts.static ? createStaticResponder(opts.static) : null;
  return async (request) => {
    const refused = localRequestRefusal(request);
    if (refused) {
      return new Response(refused, {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (respond) {
      const served = await respond(request, new URL(request.url).pathname);
      if (served) return served;
    }
    return opts.app.fetch(request);
  };
}

/** Starts the app's local server. See the module comment. */
export function serveLocal(opts: ServeLocalOptions): ServerType {
  const port = opts.port ?? localPort(opts.argv);
  const url = `http://${LOCAL_LISTEN_HOST}:${port}`;
  const onListen = opts.onListen ?? (() => console.log(`listening on ${url}`));
  return serve({ fetch: localFetch(opts), port, hostname: LOCAL_LISTEN_HOST }, () =>
    onListen({ port, url }),
  );
}
