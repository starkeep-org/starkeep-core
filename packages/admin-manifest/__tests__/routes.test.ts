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
    const routes = resolveHandlerRoutes(handler({ routes: ["GET /", "ANY /{proxy+}"], auth: "public" }));
    expect(routes.map((r) => r.auth)).toEqual(["public", "public"]);
    expect(routes.map((r) => r.catchAll)).toEqual([false, true]);
  });

  it("lets a route override the handler's auth in either direction", () => {
    const routes = resolveHandlerRoutes(
      handler({
        auth: "public",
        routes: ["GET /", { route: "ANY /api/data/{proxy+}", auth: "jwt" }],
      }),
    );
    expect(routes.map((r) => r.auth)).toEqual(["public", "jwt"]);

    const inverted = resolveHandlerRoutes(
      handler({ auth: "jwt", routes: [{ route: "GET /health", auth: "public" }] }),
    );
    expect(inverted[0]!.auth).toBe("public");
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
      auth: "public",
      routes: ["GET /", "ANY /{proxy+}", { route: "ANY /api/data/{proxy+}", auth: "jwt" }],
    }),
  );

  it("prefers the more specific route over the catch-all", () => {
    expect(matchRoute(routes, "GET", "/api/data/records")!.declared).toBe("ANY /api/data/{proxy+}");
  });

  it("falls back to the catch-all for everything else", () => {
    expect(matchRoute(routes, "GET", "/_next/static/chunk.js")!.declared).toBe("ANY /{proxy+}");
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
  // The exact shape 5.4 of the postmortem proposes: a public shell whose data
  // subtree is put back behind the authorizer by a more specific route.
  const split = handler({
    auth: "public",
    routes: ["GET /", "ANY /{proxy+}", { route: "ANY /api/data/{proxy+}", auth: "jwt" }],
    publicPaths: ["/", "/_next/static/*"],
  });

  it("says yes for the shell and its chunks", () => {
    expect(isAnonymouslyReachable(split, "GET", "/")).toBe(true);
    expect(isAnonymouslyReachable(split, "GET", "/_next/static/x.js")).toBe(true);
  });

  it("says no for the data subtree", () => {
    expect(isAnonymouslyReachable(split, "GET", "/api/data/data/records")).toBe(false);
    expect(isAnonymouslyReachable(split, "DELETE", "/api/data/data/records/abc")).toBe(false);
  });

  it("says yes for the data subtree when the handler is wholly public", () => {
    // This is what photos and memo shipped: one public catch-all over
    // everything, including the signing proxy.
    const wide = handler({ auth: "public", routes: ["GET /", "ANY /{proxy+}"], publicPaths: ["/"] });
    expect(isAnonymouslyReachable(wide, "GET", "/api/data/data/records")).toBe(true);
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
              auth: "public",
              routes: ["GET /", "ANY /{proxy+}", { route: "ANY /api/data/{proxy+}", auth: "jwt" }],
              publicPaths: ["/", "/_next/static/*"],
            },
          ],
        },
      },
    });

    expect(anonymousRoutes(manifest)).toEqual([
      {
        handlerName: "static",
        declared: "GET /",
        routeKey: "GET /apps/photos",
        catchAll: false,
        derived: false,
      },
      {
        handlerName: "static",
        declared: "ANY /{proxy+}",
        routeKey: "ANY /apps/photos/{proxy+}",
        catchAll: true,
        derived: false,
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
    expect(probePathFor("/_next/static/*")).toBe("/_next/static/x");
    expect(probePathFor("/*")).toBe("/x");
    expect(probePathFor("/sign-in")).toBe("/sign-in");
  });
});

describe("auth: \"session\" — publicPaths become real routes", () => {
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

  const DEFAULTS = ["/", "/_next/static/*", "/starkeep-runtime-config", "/sign-in", "/api/session/*"];

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
      "ANY /_next/static/{proxy+}",
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
      ["GET", "/_next/static/chunks/main.js"],
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
