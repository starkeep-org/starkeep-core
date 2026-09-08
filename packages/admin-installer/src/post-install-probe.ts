/**
 * The install-time check that an app did not just publish user data to the
 * internet.
 *
 * `formatAnonymousRouteReport` says what the manifest *declares* is anonymous.
 * This asks the deployment what is *actually* anonymous, by making
 * unauthenticated requests to it — the two can disagree, and every way they
 * can disagree is a bug worth failing an install over. The August exposure
 * would have been caught here on the day it was created; instead it ran for
 * seven weeks with an install log that said nothing.
 *
 * Three questions, and the second is the one that matters:
 *
 *   1. Does each declared public path actually answer? A declared path that
 *      401s is a broken app — most often a sign-in page nobody can reach.
 *   2. Does anything under the app's data mount answer? A 200 there means the
 *      install just published user data to the internet, and the install
 *      fails.
 *   3. Does each declared public path answer in its trailing-slash spelling
 *      too? A path has two spellings and the route table holds one, so a URL
 *      a person can plausibly type reaches a different route than the one the
 *      manifest declared.
 *
 * A 401 or a 403 is the pass condition for (2). Anything else — including a
 * 404, which usually means the route was never created — is reported but not
 * fatal, because it is not evidence of exposure.
 */
import { probePathFor, type AppComputeHandler, type AppManifest } from "@starkeep/admin-manifest";

/**
 * How long the first request to a freshly deployed handler took, against the
 * timeout that request had to finish inside.
 *
 * This probe already fires against a guaranteed-cold deployment, which is
 * exactly the condition worth measuring, so timing it costs nothing extra. The
 * defect it looks for is a handler that loads its module graph inside the
 * request rather than during INIT: the cost then lands in the billed,
 * timeout-bounded invocation while `Init Duration` still reads healthy, so
 * nothing in CloudWatch says the handler is one slow cold start from a 502.
 * Memo shipped that defect and would have read 8.0 s against a 10 s timeout on
 * the day it shipped.
 *
 * Measured rather than inspected. A static check for `import()` outside module
 * scope was considered and rejected — legitimate lazy imports exist, so it
 * would report false positives while a measurement reports the number that
 * actually matters.
 */
export interface ColdStartResult {
  handlerName: string;
  url: string;
  status: number | null;
  elapsedMs: number;
  timeoutMs: number;
  /** Fraction of the handler's own timeout the first request consumed. */
  ratio: number;
  level: "ok" | "warn" | "fail";
  error?: string;
}

/** Half the timeout is a warning; four fifths is what should fail an install. */
export const COLD_START_WARN_RATIO = 0.5;
export const COLD_START_FAIL_RATIO = 0.8;

export interface ProbeResult {
  url: string;
  status: number | null;
  /** Null when the request never completed. */
  error?: string;
}

export interface ProbeReport {
  /** True when a data path answered a request nobody authenticated. */
  exposed: boolean;
  dataPaths: ProbeResult[];
  publicPaths: ProbeResult[];
  /**
   * The trailing-slash spelling of each declared public path, in the same
   * order as `publicPaths`.
   */
  trailingSlashPaths: ProbeResult[];
  unreachablePublicPaths: ProbeResult[];
  /**
   * The cold-start measurement, or null when the manifest declares no public
   * path to measure against.
   *
   * The report only measures and grades. What a caller does with each level is
   * the caller's: `cli-install-app` warns at `"warn"` and fails the install at
   * `"fail"`, which it could only do once every app built its entry with
   * `@starkeep/app-client/lambda` — failing installs of apps that had not yet
   * migrated would have been a poor trade.
   */
  coldStart: ColdStartResult | null;
}

/** Paths under an app's mount that the broker owns and no app may claim. */
const DATA_MOUNT_PROBES = [
  "/data/records",
  "/files/probe",
  "/sync/exchange",
  "/app-data/db/probe",
];

async function probe(url: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  try {
    // No credentials of any kind. That is the whole point — this is the
    // request an anonymous stranger would make.
    const res = await fetchImpl(url, { method: "GET", redirect: "manual" });
    return { url, status: res.status };
  } catch (err) {
    return { url, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A status that proves the platform refused an unauthenticated caller. */
function isRefusal(status: number | null): boolean {
  return status === 401 || status === 403;
}

/**
 * The handler and path to time the cold start against: the one a browser
 * navigates to.
 *
 * Prefers the handler that declares the app root, because that is the request
 * whose latency a person actually experiences and the one whose module graph
 * is the whole framework. Falls back to the first handler declaring anything
 * public, and returns null for an app with no anonymous surface — there is no
 * request such an app can be asked to answer without credentials.
 */
function coldStartTarget(
  manifest: AppManifest,
): { handler: AppComputeHandler; path: string } | null {
  const handlers = manifest.infraRequirements.compute.handlers.filter(
    (h) => h.publicPaths.length > 0,
  );
  const atRoot = handlers.find((h) => h.publicPaths.includes("/"));
  if (atRoot) return { handler: atRoot, path: "/" };
  const first = handlers[0];
  if (!first) return null;
  return { handler: first, path: probePathFor(first.publicPaths[0]!) };
}

async function measureColdStart(
  manifest: AppManifest,
  root: string,
  fetchImpl: typeof fetch,
  clock: () => number,
): Promise<ColdStartResult | null> {
  const target = coldStartTarget(manifest);
  if (!target) return null;

  const url = `${root}${target.path === "/" ? "" : target.path}`;
  const started = clock();
  const result = await probe(url, fetchImpl);
  const elapsedMs = Math.round(clock() - started);
  const timeoutMs = target.handler.timeoutSeconds * 1000;
  const ratio = elapsedMs / timeoutMs;
  return {
    handlerName: target.handler.name,
    url,
    status: result.status,
    elapsedMs,
    timeoutMs,
    ratio,
    // A request that never completed says nothing about INIT placement — the
    // reachability checks below are what report that.
    level:
      result.status === null
        ? "ok"
        : ratio >= COLD_START_FAIL_RATIO
          ? "fail"
          : ratio >= COLD_START_WARN_RATIO
            ? "warn"
            : "ok",
    ...(result.error ? { error: result.error } : {}),
  };
}

export interface ProbeOptions {
  /** Injectable wall clock, so the cold-start measurement is testable. */
  clock?: () => number;
}

export async function probeAnonymousSurface(
  manifest: AppManifest,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  opts: ProbeOptions = {},
): Promise<ProbeReport> {
  const root = `${baseUrl.replace(/\/+$/, "")}/apps/${manifest.id}`;

  // First, and alone. The deployment is cold exactly once, and the volley
  // below would both race for that container and start several more, so a
  // measurement taken inside it would be timing whichever container answered
  // rather than the one that had to initialize.
  const coldStart = await measureColdStart(
    manifest,
    root,
    fetchImpl,
    opts.clock ?? (() => performance.now()),
  );

  const dataPaths = await Promise.all(
    DATA_MOUNT_PROBES.map((p) => probe(`${root}${p}`, fetchImpl)),
  );

  const declared = new Set<string>();
  for (const handler of manifest.infraRequirements.compute.handlers) {
    for (const entry of handler.publicPaths) declared.add(probePathFor(entry));
  }
  const paths = [...declared];
  const publicPaths = await Promise.all(
    paths.map((p) => probe(`${root}${p === "/" ? "" : p}`, fetchImpl)),
  );
  // The second spelling of the same path. A declared public path becomes one
  // route key with no trailing slash — API Gateway v2 refuses a key holding an
  // empty path segment, and it does not match `/x/` against the key `/x`
  // either — so the trailing-slash form falls through to the session-gated
  // `{proxy+}` and answers 401 to a caller the manifest declared anonymous.
  // Only a probe finds that: the route table and the manifest agree with each
  // other, and both disagree with the deployment.
  const trailingSlashPaths = await Promise.all(
    paths.map((p) => probe(`${root}${p === "/" ? "/" : `${p}/`}`, fetchImpl)),
  );

  return {
    exposed: dataPaths.some((r) => r.status !== null && !isRefusal(r.status) && r.status < 400),
    dataPaths,
    // A declared-public path that refuses is a broken app: most often a
    // sign-in page the gate will redirect to and then refuse.
    //
    // The app root's trailing-slash form is warned about beside them, because
    // the platform now promises that spelling: the `signed-out-redirect`
    // CloudFront function canonicalizes it, admin-web's "Open" link builds it,
    // and every bookmark of a visited app root carries it. A refusal there
    // means that canonicalization is gone.
    //
    // Deeper trailing-slash forms are reported without a warning. The
    // canonicalization deliberately stops at the root — an app that sets
    // Next's `trailingSlash` redirects `/x` to `/x/`, and stripping it here
    // would fight that redirect in a loop — so a refusal on `/sign-in/` is the
    // documented shape of the deployment rather than a regression. A browser
    // navigating there still reaches sign-in, because the same CloudFront
    // function redirects a document load holding no `sk_token` before the
    // gateway ever sees it.
    unreachablePublicPaths: [
      ...publicPaths.filter((r) => isRefusal(r.status)),
      ...trailingSlashPaths.filter((r, i) => paths[i] === "/" && isRefusal(r.status)),
    ],
    publicPaths,
    trailingSlashPaths,
    coldStart,
  };
}

export function formatProbeReport(report: ProbeReport): string {
  const lines: string[] = ["Post-install probe (unauthenticated requests against the live app):"];
  for (const r of report.dataPaths) {
    const verdict = r.status === null ? `unreachable (${r.error})` : String(r.status);
    const mark = r.status !== null && !isRefusal(r.status) && r.status < 400 ? "  <- EXPOSED" : "";
    lines.push(`  ${r.url} -> ${verdict}${mark}`);
  }
  for (const r of report.publicPaths) {
    const verdict = r.status === null ? `unreachable (${r.error})` : String(r.status);
    const mark = isRefusal(r.status) ? "  <- declared public but refused" : "";
    lines.push(`  ${r.url} -> ${verdict}${mark}`);
  }
  const warned = new Set(report.unreachablePublicPaths.map((r) => r.url));
  for (const r of report.trailingSlashPaths) {
    const verdict = r.status === null ? `unreachable (${r.error})` : String(r.status);
    const mark = !isRefusal(r.status)
      ? ""
      : warned.has(r.url)
        ? "  <- declared public but refused"
        : "  <- refused in this spelling only";
    lines.push(`  ${r.url} -> ${verdict}${mark}`);
  }
  if (report.trailingSlashPaths.some((r) => isRefusal(r.status) && !warned.has(r.url))) {
    lines.push("");
    lines.push(
      "  A path marked \"refused in this spelling only\" answers without the trailing\n" +
        "  slash. The route table holds one spelling per path and the gateway refuses\n" +
        "  to register the other, so only the app root is canonicalized in front of it.\n" +
        "  A browser navigating to one of these still reaches sign-in.",
    );
  }
  const cold = report.coldStart;
  if (cold) {
    lines.push("");
    lines.push(
      `  Cold start: ${cold.url} answered in ${(cold.elapsedMs / 1000).toFixed(1)}s ` +
        `(${Math.round(cold.ratio * 100)}% of the "${cold.handlerName}" handler's ` +
        `${cold.timeoutMs / 1000}s timeout).`,
    );
    if (cold.level !== "ok") {
      lines.push("");
      lines.push(
        `  WARNING: the first request to a cold container spent ${Math.round(cold.ratio * 100)}% of\n` +
          `           the handler's timeout. That is the signature of a handler loading its\n` +
          `           module graph inside the request instead of during INIT, where the CPU is\n` +
          `           faster, the time is not billed, and the budget is separate. Init Duration\n` +
          `           will read healthy while the cost sits in every cold request.\n` +
          `           Build the entry with \`createLambdaEntry\` from @starkeep/app-client/lambda,\n` +
          `           which takes an already-started import and awaits it at module scope.\n` +
          `           This is a warning today and becomes fatal once every app has migrated.`,
      );
    }
  }
  if (report.exposed) {
    lines.push("");
    lines.push(
      "  FAILED: a path under this app's data mount answered a request nobody\n" +
        "          authenticated. The install has published user data to the internet.",
    );
  }
  return lines.join("\n");
}
