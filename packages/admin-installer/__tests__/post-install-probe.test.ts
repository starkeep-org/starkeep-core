/**
 * The post-install probe.
 *
 * The anonymous-route report says what the manifest *declares*. This asks the
 * deployment what is *actually* anonymous, and the two can disagree — the
 * August exposure is what that disagreement looks like. The property under
 * test is that the disagreement fails the install rather than being printed
 * and scrolled past.
 */
import { describe, expect, it, vi } from "vitest";
import { appManifestSchema, type AppManifest } from "@starkeep/admin-manifest";
import {
  formatProbeReport,
  probeAnonymousSurface,
  type ProbeReport,
} from "../src/post-install-probe";

function manifest(publicPaths: string[] = ["/", "/sign-in"]): AppManifest {
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

/** Answers each URL by the first matching predicate. */
function fetchReturning(rules: [RegExp, number][]): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [pattern, status] of rules) {
      if (pattern.test(url)) return new Response(null, { status });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

const HEALTHY: [RegExp, number][] = [
  [/\/(data|files|sync|app-data)\//, 401],
  [/\/sign-in\/?$/, 200],
  [/\/apps\/memo\/?$/, 200],
];

describe("a correctly gated install", () => {
  it("is not reported as exposed", async () => {
    const report = await probeAnonymousSurface(
      manifest(),
      "https://cdn.example.com",
      fetchReturning(HEALTHY),
    );
    expect(report.exposed).toBe(false);
    expect(report.unreachablePublicPaths).toEqual([]);
  });

  it("probes every reserved data path, not one representative", async () => {
    const report = await probeAnonymousSurface(
      manifest(),
      "https://cdn.example.com",
      fetchReturning(HEALTHY),
    );
    expect(report.dataPaths.map((r) => new URL(r.url).pathname).sort()).toEqual([
      "/apps/memo/app-data/db/probe",
      "/apps/memo/data/records",
      "/apps/memo/files/probe",
      "/apps/memo/sync/exchange",
    ]);
  });

  it("accepts a 403 as a refusal, not only a 401", async () => {
    const report = await probeAnonymousSurface(
      manifest(),
      "https://cdn.example.com",
      fetchReturning([[/\/(data|files|sync|app-data)\//, 403], [/./, 200]]),
    );
    expect(report.exposed).toBe(false);
  });
});

describe("an exposed install", () => {
  it("is caught when a data path answers 200", async () => {
    // The August exposure exactly: an unauthenticated GET of the app's data
    // mount returning 200.
    const report = await probeAnonymousSurface(
      manifest(),
      "https://cdn.example.com",
      fetchReturning([[/\/app-data\//, 200], [/./, 401]]),
    );
    expect(report.exposed).toBe(true);
    expect(formatProbeReport(report)).toContain("EXPOSED");
    expect(formatProbeReport(report)).toContain("published user data to the internet");
  });

  it("is caught on any of the four mounts, not just the one an app happens to use", async () => {
    for (const mount of ["data", "files", "sync", "app-data"]) {
      const report = await probeAnonymousSurface(
        manifest(),
        "https://cdn.example.com",
        fetchReturning([[new RegExp(`/${mount}/`), 200], [/./, 401]]),
      );
      expect(report.exposed, mount).toBe(true);
    }
  });

  it("is caught on a 2xx that is not 200", async () => {
    const report = await probeAnonymousSurface(
      manifest(),
      "https://cdn.example.com",
      fetchReturning([[/\/data\//, 204], [/./, 401]]),
    );
    expect(report.exposed).toBe(true);
  });
});

describe("what is not treated as exposure", () => {
  it("a 404 — the route was probably never created", async () => {
    const report = await probeAnonymousSurface(
      manifest(),
      "https://cdn.example.com",
      fetchReturning([[/./, 404]]),
    );
    expect(report.exposed).toBe(false);
  });

  it("a 500 — a broken app is not the same as an open one", async () => {
    const report = await probeAnonymousSurface(
      manifest(),
      "https://cdn.example.com",
      fetchReturning([[/./, 500]]),
    );
    expect(report.exposed).toBe(false);
  });

  it("a request that never completed", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const report = await probeAnonymousSurface(manifest(), "https://cdn.example.com", failing);
    expect(report.exposed).toBe(false);
    expect(report.dataPaths.every((r) => r.status === null)).toBe(true);
    expect(formatProbeReport(report)).toContain("ECONNREFUSED");
  });
});

describe("declared public paths that do not answer", () => {
  it("are surfaced, because a sign-in page nobody can reach is a broken app", async () => {
    const report = await probeAnonymousSurface(
      manifest(["/", "/sign-in"]),
      "https://cdn.example.com",
      fetchReturning([[/\/sign-in$/, 401], [/\/(data|files|sync|app-data)\//, 401], [/./, 200]]),
    );
    expect(report.exposed).toBe(false);
    expect(report.unreachablePublicPaths.map((r) => new URL(r.url).pathname)).toEqual([
      "/apps/memo/sign-in",
    ]);
  });

  it("turn a wildcard declaration into a concrete path to ask about", async () => {
    const report = await probeAnonymousSurface(
      manifest(["/_next/static/*"]),
      "https://cdn.example.com",
      fetchReturning([[/./, 200]]),
    );
    expect(report.publicPaths.map((r) => new URL(r.url).pathname)).toEqual([
      "/apps/memo/_next/static/x",
    ]);
  });
});

describe("the trailing-slash spelling of a declared public path", () => {
  /**
   * A declared public path becomes one route key with no trailing slash, and
   * API Gateway v2 will not register the other spelling — it rejects a key
   * holding an empty path segment. The gateway does not treat the two as one
   * route either, so `/x/` falls through to the session-gated `{proxy+}` and
   * refuses a caller the manifest declared anonymous. The manifest and the
   * route table agree with each other and both disagree with the deployment,
   * which is exactly the disagreement only a live request can find.
   */
  it("is asked about beside the bare one", async () => {
    const report = await probeAnonymousSurface(
      manifest(["/", "/sign-in"]),
      "https://cdn.example.com",
      fetchReturning([[/./, 200]]),
    );
    expect(report.trailingSlashPaths.map((r) => new URL(r.url).pathname)).toEqual([
      "/apps/memo/",
      "/apps/memo/sign-in/",
    ]);
  });

  it("warns when the app root refuses in it, which is the spelling every link uses", async () => {
    // admin-web's "Open" link builds `/apps/<appId>/`, and so does every
    // bookmark of a visited app root. The CloudFront function canonicalizes it
    // back; a refusal here means that canonicalization is gone.
    const report = await probeAnonymousSurface(
      manifest(["/", "/sign-in"]),
      "https://cdn.example.com",
      fetchReturning([[/\/apps\/memo\/$/, 403], [/./, 200]]),
    );
    expect(report.unreachablePublicPaths.map((r) => new URL(r.url).pathname)).toEqual([
      "/apps/memo/",
    ]);
    expect(formatProbeReport(report)).toContain("/apps/memo/ -> 403  <- declared public but refused");
  });

  it("reports a deeper one without warning, because only the root is canonicalized", async () => {
    // Next's `trailingSlash: true` redirects /x to /x/, so stripping the slash
    // in front of the gateway would fight that redirect and loop. A browser
    // navigating to `/sign-in/` still reaches sign-in, because the CloudFront
    // function redirects a document load holding no `sk_token` first.
    const report = await probeAnonymousSurface(
      manifest(["/", "/sign-in"]),
      "https://cdn.example.com",
      fetchReturning([[/\/sign-in\/$/, 401], [/./, 200]]),
    );
    expect(report.unreachablePublicPaths).toEqual([]);
    const text = formatProbeReport(report);
    expect(text).toContain("/apps/memo/sign-in/ -> 401  <- refused in this spelling only");
    expect(text).toContain("answers without the trailing");
  });

  it("does not make an install fail — a refusal is not an exposure", async () => {
    const report = await probeAnonymousSurface(
      manifest(["/", "/sign-in"]),
      "https://cdn.example.com",
      fetchReturning([[/\/(data|files|sync|app-data)\//, 401], [/\/$/, 403], [/./, 200]]),
    );
    expect(report.exposed).toBe(false);
  });
});

describe("formatProbeReport", () => {
  it("stays quiet about a clean result beyond listing what it asked", async () => {
    const report: ProbeReport = await probeAnonymousSurface(
      manifest(),
      "https://cdn.example.com",
      fetchReturning(HEALTHY),
    );
    const text = formatProbeReport(report);
    expect(text).not.toContain("EXPOSED");
    expect(text).toContain("/apps/memo/data/records -> 401");
  });
});
