/**
 * The install-time answer to "what can a caller reach in this app without
 * signing in?"
 *
 * Every anonymous route is one a `session` handler's `publicPaths` derives,
 * and the validator bounds those to platform pages and static files: no
 * author can declare a route anonymous since `auth: "public"` retired
 * (2026-11-13). So the report lists the declaration exactly, never a lower
 * bound on it. It also names the routes outside clients call with a
 * delegation token, which carry a gate of their own.
 *
 * It reports; it does not decide. The rules live in `validateManifest`.
 */

import {
  anonymousRoutes,
  prefixAppRouteKey,
  resolveHandlerRoutes,
  type AppManifest,
} from "@starkeep/admin-manifest";

/**
 * Render the route report for an app, or null when every route the installer
 * will create carries a user check (the common case for an app with no
 * browser surface).
 */
export function formatAnonymousRouteReport(manifest: AppManifest): string | null {
  const entries = anonymousRoutes(manifest);
  const delegated = manifest.infraRequirements.compute.handlers.flatMap((handler) =>
    resolveHandlerRoutes(handler)
      .filter((route) => route.auth === "delegated")
      .map((route) => ({
        handlerName: handler.name,
        routeKey: prefixAppRouteKey(manifest.id, route.routeKey),
      })),
  );
  if (entries.length === 0 && delegated.length === 0) return null;

  const lines: string[] = [];
  if (entries.length > 0) {
    lines.push("Routes that answer before sign-in (through CloudFront only):");
    for (const entry of entries) {
      lines.push(
        `  ${entry.routeKey}   <- from publicPaths "${entry.declared}"   [handler: ${entry.handlerName}]`,
      );
    }
  }
  if (delegated.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Routes for outside clients (a delegation token the user created is required):");
    for (const route of delegated) {
      lines.push(`  ${route.routeKey}   [handler: ${route.handlerName}]`);
    }
  }
  return lines.join("\n");
}
