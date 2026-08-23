/**
 * The install-time answer to "what can an anonymous caller reach in this app?"
 *
 * The installer is the only place that knows the whole route table and knows
 * which routes it is about to create without an authorizer, and until now it
 * said nothing about it — a three-word `"auth": "public"` in a manifest
 * removed the Cognito authorizer from an entire catch-all and produced no
 * output at all (postmortem 2026-08-23, root cause 3.4). This module turns
 * that into a printed report, so the operator running the install and the
 * reviewer reading the log both see the anonymous surface named out loud.
 *
 * It reports; it does not decide. The refusal lives in `validateManifest`,
 * which requires a `publicPaths` declaration behind any anonymous catch-all.
 *
 * Under `auth: "session"` the report changes character. There the catch-all
 * carries the session authorizer and each `publicPaths` entry is emitted as
 * its own more-specific unauthenticated route, so what is listed below is the
 * anonymous surface exactly rather than a lower bound on it — and the
 * catch-all caveat does not apply, because for those handlers the declaration
 * *is* the reach.
 */

import { anonymousRoutes, type AppManifest } from "@starkeep/admin-manifest";

/**
 * Render the anonymous-route report for an app, or null when every route the
 * installer will create carries the JWT authorizer (the common case, and one
 * not worth a paragraph of output).
 */
export function formatAnonymousRouteReport(manifest: AppManifest): string | null {
  const entries = anonymousRoutes(manifest);
  if (entries.length === 0) return null;

  const lines: string[] = [];
  lines.push("Anonymous routes (no authorizer — reachable by anyone on the internet):");
  for (const entry of entries) {
    const marks = [
      entry.catchAll ? "catch-all" : null,
      entry.derived ? `from publicPaths "${entry.declared}"` : null,
    ].filter(Boolean);
    const suffix = marks.length > 0 ? `   <- ${marks.join(", ")}` : "";
    lines.push(`  ${entry.routeKey}${suffix}   [handler: ${entry.handlerName}]`);
  }

  const byHandler = new Map<string, string[]>();
  for (const handler of manifest.infraRequirements.compute.handlers) {
    if (handler.publicPaths.length > 0) byHandler.set(handler.name, handler.publicPaths);
  }
  if (byHandler.size > 0) {
    lines.push("");
    lines.push("Declared intentionally-public sub-paths:");
    for (const [name, paths] of byHandler) {
      lines.push(`  ${name}: ${paths.join(", ")}`);
    }
  }

  // A derived route came from a publicPaths entry on a `session` handler, so
  // it is bounded by the declaration by construction. Only a *declared*
  // anonymous catch-all is wider than what the manifest names.
  if (entries.some((e) => e.catchAll && !e.derived)) {
    lines.push("");
    lines.push(
      "  NOTE: a catch-all is wider than its declaration. The gateway will hand an " +
        "anonymous\n        request for ANY path under this handler to the app's own code, " +
        "including\n        routes the bundle mounts that the manifest never names. Everything " +
        "outside\n        the declared list above has to be refused by the handler itself — the " +
        "platform\n        does not check the end user on an app's behalf.",
    );
  }

  return lines.join("\n");
}
