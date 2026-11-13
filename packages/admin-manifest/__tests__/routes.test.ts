/**
 * Route-table reasoning: per-route auth resolution, gateway-style route
 * selection, and the anonymous-reach question the 2026-08-23 postmortem says
 * nobody was in a position to ask.
 */
import { describe, it, expect } from "vitest";
import {
  resolveHandlerRoutes,
  prefixAppRouteKey,
  matchRoute,
  isAnonymouslyReachable,
  anonymousRoutes,
  probePathFor,
} from "../src/routes.js";
import { appComputeHandlerSchema, appManifestSchema } from "../src/schema.js";

function handler(over: Record<string, unknown> = {}) {
  return appComputeHandlerSchema.parse({ name: "static", handler: "index.handler", ...over });
}

describe("resolveHandlerRoutes", () => {
  it("inherits the handler's auth for bare string routes", () => {
    const routes = resolveHandlerRoutes(
      handler({ routes: ["GET /", "ANY /{proxy+}"], auth: "jwt" }),
    );
    expect(routes.map((r) => r.auth)).toEqual(["jwt", "jwt"]);
    expect(routes.map((r) => r.catchAll)).toEqual([false, true]);
  });

  it("lets a route override the handler's auth", () => {
    const routes = resolveHandlerRoutes(
      handler({
        auth: "jwt",
        routes: ["GET /", { route: "POST /mcp", auth: "delegated" }],
      }),
    );
    expect(routes.map((r) => r.auth)).toEqual(["jwt", "delegated"]);
    expect(routes[1]!.authExplicit).toBe(true);
  });

  it("refuses a handler or a route that declares itself anonymous", () => {
    expect(() => handler({ auth: "public" })).toThrow();
    expect(() => handler({ routes: [{ route: "GET /health", auth: "public" }] })).toThrow();
  });

  it("treats $default as an ANY catch-all", () => {
    const routes = resolveHandlerRoutes(handler({ routes: [] }));
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ declared: "$default", method: "ANY", catchAll: true });
  });
});

describe("prefixAppRouteKey", () => {
  it("collapses the root route to the bare app prefix", () => {
    expect(prefixAppRouteKey("photos", "GET /")).toBe("GET /apps/photos");
  });
  it("prefixes nested paths and passes $default through", () => {
    expect(prefixAppRouteKey("photos", "ANY /{proxy+}")).toBe("ANY /apps/photos/{proxy+}");
    expect(prefixAppRouteKey("photos", "POST /api/resize")).toBe("POST /apps/photos/api/resize");
    expect(prefixAppRouteKey("photos", "$default")).toBe("$default");
  });
});

describe("matchRoute — gateway specificity", () => {
  const routes = resolveHandlerRoutes(
    handler({
      auth: "session",
      routes: ["GET /", "ANY /{proxy+}", { route: "ANY /api/data/{proxy+}", auth: "jwt" }],
    }),
  );

  it("prefers the more specific route over the catch-all", () => {
    expect(matchRoute(routes, "GET", "/api/data/records")!.declared).toBe("ANY /api/data/{proxy+}");
  });

  it("falls back to the catch-all for everything else", () => {
    expect(matchRoute(routes, "GET", "/_immutable/chunk.js")!.declared).toBe("ANY /{proxy+}");
  });

  it("matches the root route exactly, not the catch-all", () => {
    expect(matchRoute(routes, "GET", "/")!.declared).toBe("GET /");
  });

  it("returns null when nothing matches", () => {
    const only = resolveHandlerRoutes(handler({ routes: ["POST /api/resize"] }));
    expect(matchRoute(only, "GET", "/api/resize")).toBeNull();
    expect(matchRoute(only, "POST", "/api/other")).toBeNull();
  });
});

describe("isAnonymouslyReachable", () => {
  // A session shell: the declared public paths are the anonymous reach.
  const shell = handler({
    auth: "session",
    routes: ["GET /", "ANY /{proxy+}", { route: "POST /mcp", auth: "delegated" }],
    publicPaths: ["/", "/_immutable/*", "/sign-in"],
  });

  it("says yes for the shell and its chunks", () => {
    expect(isAnonymouslyReachable(shell, "GET", "/")).toBe(true);
    expect(isAnonymouslyReachable(shell, "GET", "/_immutable/x.js")).toBe(true);
  });

  it("says no for everything else, an outside client's route included", () => {
    expect(isAnonymouslyReachable(shell, "GET", "/api/local-data/data/records")).toBe(false);
    expect(isAnonymouslyReachable(shell, "POST", "/mcp")).toBe(false);
  });
});

describe("anonymousRoutes", () => {
  it("lists every authorizer-free route with its gateway key", () => {
    const manifest = appManifestSchema.parse({
      id: "photos",
      name: "Photos",
      version: "0.1.0",
      tier: "official",
      infraRequirements: {
        compute: {
          enabled: true,
          handlers: [
            { name: "api", handler: "a.handler", routes: ["POST /api/resize"] },
            {
              name: "static",
              handler: "index.handler",
              auth: "session",
              routes: ["GET /", "ANY /{proxy+}", { route: "POST /mcp", auth: "delegated" }],
              publicPaths: ["/", "/_immutable/*"],
            },
          ],
        },
      },
    });

    expect(anonymousRoutes(manifest)).toEqual([
      {
        handlerName: "static",
        declared: "/",
        routeKey: "ANY /apps/photos",
        catchAll: false,
        derived: true,
      },
      {
        handlerName: "static",
        declared: "/_immutable/*",
        routeKey: "ANY /apps/photos/_immutable/{proxy+}",
        catchAll: true,
        derived: true,
      },
    ]);
  });

  it("is empty when every route carries the authorizer", () => {
    const manifest = appManifestSchema.parse({
      id: "quiet",
      name: "Quiet",
      version: "0.1.0",
      tier: "community",
      infraRequirements: {
        compute: { enabled: true, handlers: [{ name: "api", handler: "a.handler" }] },
      },
    });
    expect(anonymousRoutes(manifest)).toEqual([]);
  });
});

describe("probePathFor", () => {
  it("turns a wildcard declaration into a concrete path", () => {
    expect(probePathFor("/_immutable/*")).toBe("/_immutable/x");
    expect(probePathFor("/*")).toBe("/x");
    expect(probePathFor("/sign-in")).toBe("/sign-in");
  });
});

describe('auth: "session" — publicPaths become real routes', () => {
  /**
   * The inversion the 2026-08-23 postmortem asks for. Under `public` a
   * catch-all was wider than the declaration beside it, so `publicPaths` was a
   * statement of intent that enforced nothing. Under `session` the catch-all
   * is gated and each entry is emitted as a more-specific unauthenticated
   * route, so the declaration *is* the reach.
   */
  function sessionManifest(publicPaths: string[]) {
    return appManifestSchema.parse({
      id: "memo",
      name: "Memo",
      version: "0.1.0",
      tier: "official",
      infraRequirements: {
        compute: {
          enabled: true,
          handlers: [
            {
              name: "static",
              handler: "index.handler",
              auth: "session",
              routes: ["GET /", "ANY /{proxy+}"],
              publicPaths,
            },
          ],
        },
      },
    });
  }

  const DEFAULTS = ["/", "/_immutable/*", "/starkeep-runtime-config", "/sign-in", "/api/session/*"];

  it("gates the catch-all", () => {
    const handler = sessionManifest(DEFAULTS).infraRequirements.compute.handlers[0]!;
    const catchAll = resolveHandlerRoutes(handler).find(
      (r) => r.path === "/{proxy+}" && !r.derived,
    );
    expect(catchAll?.auth).toBe("session");
  });

  it("emits one unauthenticated route per declared public path", () => {
    const handler = sessionManifest(DEFAULTS).infraRequirements.compute.handlers[0]!;
    const derived = resolveHandlerRoutes(handler).filter((r) => r.derived);
    expect(derived.map((r) => `${r.method} ${r.path}`)).toEqual([
      "ANY /",
      "ANY /_immutable/{proxy+}",
      "ANY /starkeep-runtime-config",
      "ANY /sign-in",
      "ANY /api/session/{proxy+}",
    ]);
    expect(derived.every((r) => r.auth === "public")).toBe(true);
  });

  it("replaces a declared route on the same path, whatever its method", () => {
    // The manifest declares `GET /` and the declaration covers `/`. Left
    // alongside each other, API Gateway prefers the concrete method, so the
    // app root would come out gated with a public route beside it that never
    // matched — the exact opposite of what the manifest says.
    const handler = sessionManifest(DEFAULTS).infraRequirements.compute.handlers[0]!;
    const atRoot = resolveHandlerRoutes(handler).filter((r) => r.path === "/");
    expect(atRoot).toHaveLength(1);
    expect(atRoot[0]!.auth).toBe("public");
    expect(atRoot[0]!.derived).toBe(true);
  });

  it("leaves an undeclared path gated, which is the whole point", () => {
    const handler = sessionManifest(DEFAULTS).infraRequirements.compute.handlers[0]!;
    const routes = resolveHandlerRoutes(handler);
    expect(matchRoute(routes, "GET", "/api/local-data/app-data/db/decks")?.auth).toBe("session");
    expect(matchRoute(routes, "POST", "/api/local-data/data/records")?.auth).toBe("session");
    expect(matchRoute(routes, "GET", "/browse")?.auth).toBe("session");
  });

  it("lets each declared path through", () => {
    const handler = sessionManifest(DEFAULTS).infraRequirements.compute.handlers[0]!;
    const routes = resolveHandlerRoutes(handler);
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/_immutable/chunks/main.js"],
      ["GET", "/starkeep-runtime-config"],
      ["GET", "/sign-in"],
      ["POST", "/api/session/sign-in"],
    ] as const) {
      expect(matchRoute(routes, method, path)?.auth, `${method} ${path}`).toBe("public");
    }
  });

  it("reports the derived routes, not the catch-all, as the anonymous surface", () => {
    const entries = anonymousRoutes(sessionManifest(["/", "/sign-in"]));
    expect(entries).toEqual([
      {
        handlerName: "static",
        declared: "/",
        routeKey: "ANY /apps/memo",
        catchAll: false,
        derived: true,
      },
      {
        handlerName: "static",
        declared: "/sign-in",
        routeKey: "ANY /apps/memo/sign-in",
        catchAll: false,
        derived: true,
      },
    ]);
    // Nothing anonymous is a catch-all, so the surface is exact rather than a
    // lower bound.
    expect(entries.some((e) => e.catchAll)).toBe(false);
  });

  it("treats a wildcard public path as a catch-all in the report", () => {
    // `/api/session/*` really is a subtree, and the report should say so even
    // though it is bounded by the declaration.
    const entries = anonymousRoutes(sessionManifest(["/api/session/*"]));
    expect(entries).toEqual([
      {
        handlerName: "static",
        declared: "/api/session/*",
        routeKey: "ANY /apps/memo/api/session/{proxy+}",
        catchAll: true,
        derived: true,
      },
    ]);
  });
});
