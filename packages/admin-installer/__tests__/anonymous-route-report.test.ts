/**
 * The install-time route report: every route an install creates without a
 * user check, named by its gateway key and by the declaration it came from,
 * plus the routes outside clients call with a delegation token.
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

const shell = (over: Record<string, unknown> = {}) => ({
  name: "static",
  handler: "index.handler",
  auth: "session",
  routes: ["GET /", "ANY /{proxy+}"],
  publicPaths: ["/", "/_immutable/*", "/sign-in", "/api/session/*"],
  ...over,
});

describe("formatAnonymousRouteReport", () => {
  it("says nothing when every route carries a user check", () => {
    expect(
      formatAnonymousRouteReport(
        manifest([{ name: "api", handler: "a.handler", routes: ["POST /api/resize"] }]),
      ),
    ).toBeNull();
  });

  it("lists each derived route and the declaration it came from", () => {
    const report = formatAnonymousRouteReport(
      manifest([{ name: "api", handler: "a.handler", routes: ["POST /api/resize"] }, shell()]),
    )!;
    expect(report).toContain("ANY /apps/photos ");
    expect(report).toContain('ANY /apps/photos/sign-in   <- from publicPaths "/sign-in"');
    // The authenticated handler's route must not appear — a report that lists
    // protected routes alongside open ones teaches the reader to skim it.
    expect(report).not.toContain("POST /apps/photos/api/resize");
  });

  it("never lists the gated catch-all, which is where the app's code answers", () => {
    const report = formatAnonymousRouteReport(manifest([shell()]))!;
    expect(report).not.toContain("ANY /apps/photos/{proxy+}");
  });

  it("names the routes outside clients call, apart from the anonymous ones", () => {
    const report = formatAnonymousRouteReport(
      manifest([
        shell({ routes: ["GET /", "ANY /{proxy+}", { route: "POST /mcp", auth: "delegated" }] }),
      ]),
    )!;
    const [anonymous, outside] = report.split("\n\n");
    expect(anonymous).not.toContain("/mcp");
    expect(outside).toContain("Routes for outside clients");
    expect(outside).toContain("POST /apps/photos/mcp");
  });
});
