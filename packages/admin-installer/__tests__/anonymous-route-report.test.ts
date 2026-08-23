/**
 * The install-time anonymous-route report. Its job is to make a `"auth":
 * "public"` line in a manifest cost something visible: before this, the
 * installer's own output — the one place that knows the whole route table —
 * said nothing at all about which routes it was creating without an
 * authorizer (postmortem 2026-08-23, root cause 3.4).
 */
import { describe, it, expect } from "vitest";
import { appManifestSchema, type AppManifest } from "@starkeep/admin-manifest";
import { formatAnonymousRouteReport } from "../src/anonymous-route-report";

function manifest(handlers: Record<string, unknown>[]): AppManifest {
  return appManifestSchema.parse({
    id: "photos",
    name: "Photos",
    version: "0.1.0",
    tier: "official",
    infraRequirements: { compute: { enabled: true, handlers } },
  });
}

describe("formatAnonymousRouteReport", () => {
  it("says nothing when every route carries the authorizer", () => {
    expect(
      formatAnonymousRouteReport(
        manifest([{ name: "api", handler: "a.handler", routes: ["POST /api/resize"] }]),
      ),
    ).toBeNull();
  });

  it("names each anonymous route by its gateway key and flags the catch-all", () => {
    const report = formatAnonymousRouteReport(
      manifest([
        { name: "api", handler: "a.handler", routes: ["POST /api/resize"] },
        {
          name: "static",
          handler: "index.handler",
          auth: "public",
          routes: ["GET /", "ANY /{proxy+}"],
          publicPaths: ["/", "/_next/static/*"],
        },
      ]),
    )!;

    expect(report).toContain("GET /apps/photos");
    expect(report).toContain("ANY /apps/photos/{proxy+}");
    expect(report).toContain("catch-all");
    // The authenticated handler's route must not appear — a report that lists
    // protected routes alongside open ones teaches the reader to skim it.
    expect(report).not.toContain("POST /apps/photos/api/resize");
  });

  it("prints the declared public sub-paths alongside the routes", () => {
    const report = formatAnonymousRouteReport(
      manifest([
        {
          name: "static",
          handler: "index.handler",
          auth: "public",
          routes: ["GET /", "ANY /{proxy+}"],
          publicPaths: ["/", "/_next/static/*"],
        },
      ]),
    )!;
    expect(report).toContain("/_next/static/*");
  });

  it("warns that a catch-all reaches further than its declaration", () => {
    const report = formatAnonymousRouteReport(
      manifest([
        {
          name: "static",
          handler: "index.handler",
          auth: "public",
          routes: ["GET /", "ANY /{proxy+}"],
          publicPaths: ["/"],
        },
      ]),
    )!;
    expect(report).toContain("wider than its declaration");
  });

  it("omits the catch-all warning when only named routes are public", () => {
    const report = formatAnonymousRouteReport(
      manifest([
        {
          name: "api",
          handler: "a.handler",
          routes: ["POST /api/resize", { route: "GET /api/health", auth: "public" }],
        },
      ]),
    )!;
    expect(report).toContain("GET /apps/photos/api/health");
    expect(report).not.toContain("wider than its declaration");
  });
});

describe("formatAnonymousRouteReport under auth: \"session\"", () => {
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

  it("lists the derived routes and says where each came from", () => {
    const report = formatAnonymousRouteReport(sessionManifest(["/", "/sign-in"]))!;
    expect(report).toContain("ANY /apps/memo");
    expect(report).toContain("ANY /apps/memo/sign-in");
    expect(report).toContain('from publicPaths "/sign-in"');
  });

  it("drops the catch-all caveat, because for these handlers there isn't one", () => {
    // The caveat says a catch-all is wider than its declaration. Under
    // `session` the catch-all is gated and the declaration is the reach, so
    // repeating the warning would describe a hole that is not there — and a
    // warning that is not true is worse than none.
    const report = formatAnonymousRouteReport(sessionManifest(["/", "/sign-in"]))!;
    expect(report).not.toContain("wider than its declaration");
  });

  it("keeps the caveat for a handler that really does leave a catch-all open", () => {
    const manifest = appManifestSchema.parse({
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
              auth: "public",
              routes: ["GET /", "ANY /{proxy+}"],
              publicPaths: ["/", "/_next/static/*"],
            },
          ],
        },
      },
    });
    expect(formatAnonymousRouteReport(manifest)).toContain("wider than its declaration");
  });

  it("does not list the data proxy, which is the whole point", () => {
    const report = formatAnonymousRouteReport(
      sessionManifest(["/", "/_next/static/*", "/sign-in", "/api/session/*"]),
    )!;
    expect(report).not.toContain("local-data");
    // A declared wildcard like /api/session/* is a bounded catch-all and is
    // listed as one. What must not appear is the unbounded one — the app's
    // whole surface — which is the route the exposure lived behind.
    expect(report).not.toContain("ANY /apps/memo/{proxy+}");
  });
});
