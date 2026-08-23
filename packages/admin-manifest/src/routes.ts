/**
 * Route-table reasoning shared by the manifest validator, the installer's
 * anonymous-route report, and the Pulumi program that creates the API Gateway
 * routes.
 *
 * All three need the same three answers and used to derive them separately (or
 * not at all): what an app's declared route becomes once it is prefixed under
 * `/apps/<appId>`, which of those routes carry no authorizer, and which
 * concrete paths an anonymous caller can therefore reach. The postmortem of
 * 2026-08-23 traced the unauthenticated-cloud-apps exposure to exactly that
 * gap — the facts existed in separate places and were never composed — so the
 * composition lives here, in one module, with one vocabulary.
 */

import type { AppComputeHandler, AppComputeRoute, AppManifest } from "./schema.js";

/** A handler route with its per-route auth override already resolved. */
export interface ResolvedRoute {
  /** The route exactly as the manifest declared it, e.g. `ANY /{proxy+}`. */
  declared: string;
  /** HTTP method, or `ANY`. `$default` routes report `ANY`. */
  method: string;
  /**
   * Path portion of the route key, e.g. `/{proxy+}`. The catch-all `$default`
   * route has no path of its own and reports `/{proxy+}` — it matches
   * everything the gateway does not route elsewhere, which is the same reach.
   */
  path: string;
  /** Effective auth: the route's own override, else the handler's default. */
  auth: "public" | "jwt";
  /** True for `$default` and for any route whose path ends in `{proxy+}`. */
  catchAll: boolean;
}

/** Normalize one manifest route entry to its string form and auth override. */
function routeParts(route: AppComputeRoute): { key: string; auth?: "public" | "jwt" } {
  return typeof route === "string" ? { key: route } : { key: route.route, auth: route.auth };
}

/**
 * Resolve a handler's declared routes, applying each route's `auth` override
 * over the handler-level `auth`. An empty `routes` array means `$default`,
 * matching the Pulumi program's own fallback.
 */
export function resolveHandlerRoutes(handler: AppComputeHandler): ResolvedRoute[] {
  const declaredRoutes = handler.routes.length > 0 ? handler.routes : ["$default"];
  return declaredRoutes.map((entry) => {
    const { key, auth } = routeParts(entry);
    if (key === "$default") {
      return {
        declared: key,
        method: "ANY",
        path: "/{proxy+}",
        auth: auth ?? handler.auth,
        catchAll: true,
      };
    }
    const match = key.match(/^([A-Z]+) (\/.*)$/);
    const method = match?.[1] ?? "ANY";
    const path = match?.[2] ?? "/";
    return {
      declared: key,
      method,
      path,
      auth: auth ?? handler.auth,
      catchAll: /\{proxy\+\}$/.test(path),
    };
  });
}

/**
 * Prefix a declared route key under the app's `/apps/<appId>` namespace, the
 * platform's routing convention for every per-app handler.
 *
 * `GET /` must collapse to `GET /apps/<appId>` with no trailing slash: API
 * Gateway v2 rejects a route key containing an empty path segment
 * ("BadRequestException: Part of the given route key path is empty").
 * `$default` passes through unprefixed — it is not a path.
 */
export function prefixAppRouteKey(appId: string, routeKey: string): string {
  if (routeKey === "$default") return routeKey;
  return routeKey.replace(/^([A-Z]+) \/(.*)$/, (_m, method: string, rest: string) =>
    rest === "" ? `${method} /apps/${appId}` : `${method} /apps/${appId}/${rest}`,
  );
}

/**
 * How specifically a route matches a path, as an array compared
 * lexicographically — higher wins. This mirrors API Gateway v2's documented
 * selection rule: it prefers the route with the most literal segments, treats
 * `{param}` as less specific than a literal, and `{proxy+}` as least specific
 * of all. A concrete method beats `ANY`.
 *
 * It is an approximation of the gateway's internal algorithm, but it is the
 * same approximation the platform already reasoned with informally (see the
 * reserved-subpath check in `pulumi-program.ts`), and it is only ever used to
 * *over*-report anonymous reach: when two routes tie, `matchRoute` keeps the
 * anonymous one, so the report never claims a path is protected when it might
 * not be.
 */
function specificity(route: ResolvedRoute, segments: string[]): number[] | null {
  const routeSegments = route.path.split("/").filter((s) => s.length > 0);
  const score: number[] = [];
  for (let i = 0; i < routeSegments.length; i++) {
    const seg = routeSegments[i]!;
    if (seg.endsWith("{proxy+}")) {
      // Greedy: matches this segment and every one after it, including none.
      if (segments.length < i) return null;
      score.push(0);
      return score;
    }
    if (i >= segments.length) return null;
    if (seg.startsWith("{") && seg.endsWith("}")) {
      score.push(1);
      continue;
    }
    if (seg !== segments[i]) return null;
    score.push(2);
  }
  // A non-greedy route must consume the path exactly.
  if (routeSegments.length !== segments.length) return null;
  return score;
}

function compareScores(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? -1;
    const bv = b[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * The route API Gateway would select for `method path` out of `routes`, or
 * null if none match. Ties are broken toward the anonymous route so callers
 * that ask "can an anonymous request reach this?" never get a falsely
 * reassuring answer.
 */
export function matchRoute(
  routes: ResolvedRoute[],
  method: string,
  path: string,
): ResolvedRoute | null {
  const segments = path.split("/").filter((s) => s.length > 0);
  let best: ResolvedRoute | null = null;
  let bestScore: number[] | null = null;
  for (const route of routes) {
    if (route.method !== "ANY" && route.method !== method.toUpperCase()) continue;
    const score = specificity(route, segments);
    if (!score) continue;
    // A concrete method outranks ANY at equal path specificity.
    const withMethod = [...score, route.method === "ANY" ? 0 : 1];
    if (!bestScore) {
      best = route;
      bestScore = withMethod;
      continue;
    }
    const cmp = compareScores(withMethod, bestScore);
    if (cmp > 0 || (cmp === 0 && route.auth === "public")) {
      best = route;
      bestScore = withMethod;
    }
  }
  return best;
}

/** True when an anonymous caller can reach `method path` on this handler. */
export function isAnonymouslyReachable(
  handler: AppComputeHandler,
  method: string,
  path: string,
): boolean {
  return matchRoute(resolveHandlerRoutes(handler), method, path)?.auth === "public";
}

export interface AnonymousRouteEntry {
  handlerName: string;
  /** Route key as declared in the manifest. */
  declared: string;
  /** Route key as it will exist on the shared API Gateway. */
  routeKey: string;
  catchAll: boolean;
}

/**
 * Every route the installer will create with no authorizer attached, across
 * every compute handler in the manifest. This is the artifact the install-time
 * report prints and the validator gates on: one place that answers "what can
 * an anonymous caller reach in this app?".
 */
export function anonymousRoutes(manifest: AppManifest): AnonymousRouteEntry[] {
  const entries: AnonymousRouteEntry[] = [];
  for (const handler of manifest.infraRequirements.compute.handlers) {
    for (const route of resolveHandlerRoutes(handler)) {
      if (route.auth !== "public") continue;
      entries.push({
        handlerName: handler.name,
        declared: route.declared,
        routeKey: prefixAppRouteKey(manifest.id, route.declared),
        catchAll: route.catchAll,
      });
    }
  }
  return entries;
}

/**
 * Turn a `publicPaths` declaration into a concrete path to test against the
 * route table. `/_next/static/*` probes as `/_next/static/x`; a literal entry
 * probes as itself.
 */
export function probePathFor(publicPath: string): string {
  if (publicPath === "/*") return "/x";
  if (publicPath.endsWith("/*")) return `${publicPath.slice(0, -2)}/x`;
  return publicPath;
}
