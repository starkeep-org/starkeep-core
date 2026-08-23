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
