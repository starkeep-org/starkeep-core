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
 * Two questions, and the second is the one that matters:
 *
 *   1. Does each declared public path actually answer? A declared path that
 *      401s is a broken app — most often a sign-in page nobody can reach.
 *   2. Does anything under the app's data mount answer? A 200 there means the
 *      install just published user data to the internet, and the install
 *      fails.
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
  const publicPaths = await Promise.all(
    [...declared].map((p) => probe(`${root}${p === "/" ? "" : p}`, fetchImpl)),
  );

  return {
    exposed: dataPaths.some((r) => r.status !== null && !isRefusal(r.status) && r.status < 400),
    dataPaths,
    // A declared-public path that refuses is a broken app: most often a
    // sign-in page the gate will redirect to and then refuse.
    unreachablePublicPaths: publicPaths.filter((r) => isRefusal(r.status)),
    publicPaths,
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
  if (report.exposed) {
    lines.push("");
    lines.push(
      "  FAILED: a path under this app's data mount answered a request nobody\n" +
        "          authenticated. The install has published user data to the internet.",
    );
  }
  return lines.join("\n");
}
