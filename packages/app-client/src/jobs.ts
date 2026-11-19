/**
 * Scheduled jobs: work an app runs for each user who turns it on, in the
 * cloud, at the user's time of day or when the user asks.
 *
 * The app declares each job in its manifest's `infraRequirements.jobs`. A user
 * turns a job on on the platform's consent page, whose address
 * {@link listJobs} returns. The platform's dispatcher then invokes the app's
 * function with `POST /apps/<appId>/_starkeep/jobs/<name>` and a `job` token
 * for that user. The app:
 *
 * 1. mounts the job route ahead of its session gate, because the run carries
 *    no session cookie;
 * 2. calls {@link verifyJob} to learn whose run this is, and answers
 *    {@link jobRefusal} when it returns null;
 * 3. passes the returned `token` to every data call (`signedFetch`'s
 *    `delegation` option or `proxyToDataServer`'s `delegationToken`), so the
 *    platform applies the job's mode to each one; and
 * 4. answers 2xx when the run succeeded, with an optional JSON `message` the
 *    user sees beside the run.
 *
 * The token works only while its run lasts. Jobs run in the cloud only: on
 * the local surface {@link verifyJob} refuses every request, and
 * {@link listJobs} and {@link runJobNow} report `cloudRequired`, so an app
 * can tell the user that background jobs need a cloud.
 */

import { loadAppCredentials, type AppCredentials } from "./credentials";
import { verifyDelegationToken, type DelegationMode } from "./delegation";
import { signedFetch, USER_TOKEN_HEADER } from "./sign";

/** The path, under the app's prefix, where the dispatcher runs a job. */
export const JOB_ROUTE_PREFIX = "/_starkeep/jobs/";

/** One run of a job, as {@link verifyJob} answers it. */
export interface JobRun {
  /** The user the run acts for. */
  userId: string;
  job: string;
  /** This run's id. Stable for the run, new for the next one. */
  runId: string;
  mode: DelegationMode;
  /** Forward on every data call. */
  token: string;
}

/** The parts of a request {@link verifyJob} reads. */
export interface JobRequest {
  headers: { get(name: string): string | null };
}

/**
 * The run a dispatcher request carries for job `name`, or null to refuse it.
 *
 * In the cloud, the bearer must be a `job` token this deployment signed, for
 * this app and this job, unexpired. The platform checks that the run still
 * holds its lease on every data call the app then makes. On the local
 * surface, where no job runs, every request is refused.
 */
export async function verifyJob(req: JobRequest, name: string): Promise<JobRun | null> {
  if (process.env.STARKEEP_APP_CLIENT_MODE !== "cloud") return null;
  const appId = process.env.STARKEEP_APP_ID;
  const cloudDataBase = process.env.STARKEEP_CLOUD_DATA_BASE;
  if (!appId || !cloudDataBase) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!match) return null;
  const verified = await verifyDelegationToken(match[1]!, { appId, cloudDataBase });
  if (!verified || verified.channel !== "job" || !verified.job) return null;
  if (verified.job.name !== name || !verified.userId) return null;
  return {
    userId: verified.userId,
    job: verified.job.name,
    runId: verified.job.runId,
    mode: verified.mode,
    token: verified.token!,
  };
}

/**
 * The answer for a job request {@link verifyJob} refused: a 404, so a probe
 * of the path learns nothing about the app's jobs.
 */
export function jobRefusal(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

/** Why a job needs the user, or null when it is healthy. */
export type JobAttention = "failed" | "signed-out" | "no-library" | "needs-consent";

/** One of the app's jobs, with the signed-in user's enrollment in it. */
export interface JobState {
  name: string;
  /** The sentence the consent page shows. */
  description: string;
  /** The mode the app asks for. */
  mode: DelegationMode;
  defaultTime: string | null;
  /** Whether the user turned the job on. A stopped job stays on, with `attention` set. */
  enabled: boolean;
  /** `HH:MM` in `timeZone`, or null for a job that runs only when the user asks. */
  timeOfDay: string | null;
  timeZone: string | null;
  /** Milliseconds since the epoch. */
  nextRunAt: number | null;
  running: boolean;
  lastRun: {
    status: "ok" | "failed" | "deferred" | "stopped";
    startedAt: number | null;
    finishedAt: number | null;
    message: string | null;
  } | null;
  attention: JobAttention | null;
  /** The consent page, without a time zone or a return path. See {@link jobConsentUrl}. */
  consentUrl: string;
}

/** The app's jobs, or `cloudRequired` on the local surface. */
export type JobList =
  | { cloudRequired: false; jobs: JobState[] }
  | { cloudRequired: true; jobs: [] };

/** How a "run now" ended. */
export type RunNowResult =
  | { ok: true; runId: string }
  | { ok: false; cloudRequired: true }
  | {
      ok: false;
      cloudRequired: false;
      status: number;
      /** `not-enabled`, `running`, `needs-consent`, `signed-out` or `no-library`, when known. */
      code: string | null;
      error: string;
    };

export interface JobCallOptions {
  /** The signed-in user's ID token. Required in the cloud. */
  userToken: string | null;
  /** Test seam: the app's credentials, rather than loading them. */
  creds?: AppCredentials;
}

async function credentialsFor(appId: string, opts: JobCallOptions): Promise<AppCredentials> {
  const creds = opts.creds ?? (await loadAppCredentials(appId));
  if (!creds) throw new Error(`${appId} is not installed on this surface`);
  return creds;
}

function userHeaders(opts: JobCallOptions): Record<string, string> {
  return opts.userToken ? { [USER_TOKEN_HEADER]: opts.userToken } : {};
}

async function isCloudRequired(res: Response): Promise<boolean> {
  if (res.status !== 501) return false;
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { code?: unknown };
  return body.code === "cloud-required";
}

/** The app's jobs and the signed-in user's enrollment in each. Call from the app's server. */
export async function listJobs(appId: string, opts: JobCallOptions): Promise<JobList> {
  const creds = await credentialsFor(appId, opts);
  const res = await signedFetch(creds, "/jobs", { headers: userHeaders(opts) });
  if (await isCloudRequired(res)) return { cloudRequired: true, jobs: [] };
  if (!res.ok) throw new Error(`Listing ${appId}'s jobs answered ${res.status}`);
  const body = (await res.json()) as { jobs: JobState[] };
  return { cloudRequired: false, jobs: body.jobs };
}

/** Start one run of job `name` for the signed-in user now. Call from the app's server. */
export async function runJobNow(
  appId: string,
  name: string,
  opts: JobCallOptions,
): Promise<RunNowResult> {
  const creds = await credentialsFor(appId, opts);
  const res = await signedFetch(creds, `/jobs/${encodeURIComponent(name)}/run`, {
    method: "POST",
    headers: userHeaders(opts),
  });
  if (await isCloudRequired(res)) return { ok: false, cloudRequired: true };
  const body = (await res.json().catch(() => ({}))) as {
    runId?: unknown;
    code?: unknown;
    error?: unknown;
  };
  if (res.status === 202 && typeof body.runId === "string") return { ok: true, runId: body.runId };
  return {
    ok: false,
    cloudRequired: false,
    status: res.status,
    code: typeof body.code === "string" ? body.code : null,
    error: typeof body.error === "string" ? body.error : `The run answered ${res.status}`,
  };
}

/**
 * The consent page's address for `job`, with the browser's time zone
 * preselected and a path in the app to return to. Link the browser to it.
 * `returnTo` must be a path under `/apps/<appId>/`; the page ignores any
 * other.
 */
export function jobConsentUrl(
  job: Pick<JobState, "consentUrl">,
  opts: { timeZone?: string; returnTo?: string } = {},
): string {
  const url = new URL(job.consentUrl);
  if (opts.timeZone) url.searchParams.set("tz", opts.timeZone);
  if (opts.returnTo) url.searchParams.set("return", opts.returnTo);
  return url.toString();
}
