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
import { probePathFor, type AppManifest } from "@starkeep/admin-manifest";

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

export async function probeAnonymousSurface(
  manifest: AppManifest,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeReport> {
  const root = `${baseUrl.replace(/\/+$/, "")}/apps/${manifest.id}`;

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
  if (report.exposed) {
    lines.push("");
    lines.push(
      "  FAILED: a path under this app's data mount answered a request nobody\n" +
        "          authenticated. The install has published user data to the internet.",
    );
  }
  return lines.join("\n");
}
