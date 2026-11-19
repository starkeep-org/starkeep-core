/**
 * The data server's job routes for an app's own server, on behalf of the
 * signed-in user:
 *
 * - `GET /apps/<appId>/jobs` lists the app's jobs with the user's enrollment
 *   in each: whether it is on, its schedule, its last run, why it needs the
 *   user, and the consent page's address.
 * - `POST /apps/<appId>/jobs/<name>/run` starts a run now. The route claims
 *   the enrollment's lease, hands the run to the dispatcher asynchronously
 *   and answers 202 with the run's id. A run already holding the lease, or
 *   no live enrollment, answers 409.
 *
 * Both take only the app's signature with the user's token: the caller in
 * `api-handler.ts` refuses devices, mobile keys and every delegation channel
 * before calling in here, so a job's own run cannot start another run.
 */
import { CONNECT_JOB_ROUTE, type DelegationMode } from "@starkeep/protocol-primitives";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import { leaseMsFor, newLeaseId, templateFor, type ManualRunEvent } from "./dispatcher.js";
import { loadJobApp, runMode } from "./job-manifest.js";
import { NEEDS_CONSENT_MESSAGE } from "./job-messages.js";
import {
  claimLease,
  enrollmentId,
  findEnrollment,
  leaseIsLive,
  listEnrollments,
  recordOutcome,
  stopEnrollment,
  type JobAttention,
  type JobRow,
  type JobStatus,
} from "./job-store.js";

const RUN_PATH = /^\/jobs\/([a-z][a-z0-9-]{0,31})\/run$/;

/** Which job route a request names, or null for any other route. */
export function jobRouteOf(
  method: string,
  subPath: string,
): { kind: "list" } | { kind: "run"; job: string } | null {
  if (method === "GET" && subPath === "/jobs") return { kind: "list" };
  const run = method === "POST" ? RUN_PATH.exec(subPath) : null;
  return run ? { kind: "run", job: run[1]! } : null;
}

export interface JobRouteDeps {
  db(): Promise<DatabaseClient>;
  /** The gateway's own host name, where the consent page answers. */
  gatewayHost: string;
  startManualRun(event: ManualRunEvent): Promise<void>;
  now?: () => number;
  newLeaseId?: () => string;
}

/** One job as `GET /apps/<appId>/jobs` describes it. */
export interface JobView {
  name: string;
  description: string;
  /** The mode the app asks for. */
  mode: DelegationMode;
  defaultTime: string | null;
  /** Whether the user has the job on. A stopped job stays on, with `attention` set. */
  enabled: boolean;
  timeOfDay: string | null;
  timeZone: string | null;
  /** Milliseconds since the epoch, or null for a manual-only or stopped job. */
  nextRunAt: number | null;
  running: boolean;
  lastRun: {
    status: JobStatus;
    startedAt: number | null;
    finishedAt: number | null;
    message: string | null;
  } | null;
  attention: JobAttention | null;
  /** Where the user turns the job on or approves a change. */
  consentUrl: string;
}

interface Answer {
  status: number;
  body: unknown;
}

function viewOf(
  appId: string,
  template: { name: string; description: string; mode: DelegationMode; defaultTime: string | null },
  row: JobRow | undefined,
  gatewayHost: string,
  nowMs: number,
): JobView {
  const enabled = !!row && row.revoked_at_ms === null;
  const consent = new URL(`https://${gatewayHost}${CONNECT_JOB_ROUTE}`);
  consent.search = new URLSearchParams({ app: appId, job: template.name }).toString();
  return {
    name: template.name,
    description: template.description,
    mode: template.mode,
    defaultTime: template.defaultTime,
    enabled,
    timeOfDay: enabled ? row!.time_of_day : null,
    timeZone: enabled ? row!.time_zone : null,
    nextRunAt: enabled ? row!.next_due_at_ms : null,
    running: !!row && leaseIsLive(row, nowMs),
    lastRun:
      row?.last_status != null
        ? {
            status: row.last_status,
            startedAt: row.last_started_at_ms,
            finishedAt: row.last_finished_at_ms,
            message: row.last_message,
          }
        : null,
    attention: enabled ? row!.attention : null,
    consentUrl: consent.toString(),
  };
}

/** Answer one job route for `userId` on `appId`. Call only when {@link jobRouteOf} matched. */
export async function handleJobRoute(
  route: NonNullable<ReturnType<typeof jobRouteOf>>,
  appId: string,
  userId: string,
  deps: JobRouteDeps,
): Promise<Answer> {
  const now = (deps.now ?? Date.now)();
  const db = await deps.db();
  const app = await loadJobApp(db, appId);
  if (!app) return { status: 404, body: { error: `${appId} has no cloud web app here` } };

  if (route.kind === "list") {
    const rows = await listEnrollments(db, userId, appId);
    const byJob = new Map(rows.map((r) => [r.job, r]));
    return {
      status: 200,
      body: {
        jobs: app.jobs.map((t) => viewOf(appId, t, byJob.get(t.name), deps.gatewayHost, now)),
      },
    };
  }

  const template = templateFor(app, route.job);
  if (!template) return { status: 404, body: { error: `${appId} has no job ${route.job}` } };
  const id = enrollmentId(userId, appId, route.job);
  const row = await findEnrollment(db, id);
  if (!row || row.revoked_at_ms !== null) {
    return { status: 409, body: { error: "Turn the job on first", code: "not-enabled" } };
  }
  if (row.attention && row.attention !== "failed") {
    return {
      status: 409,
      body: { error: "The job is stopped until you turn it on again", code: row.attention },
    };
  }
  if (!runMode(row.mode, template)) {
    await stopEnrollment(db, id, "needs-consent", NEEDS_CONSENT_MESSAGE, now);
    return { status: 409, body: { error: NEEDS_CONSENT_MESSAGE, code: "needs-consent" } };
  }
  const leaseId = (deps.newLeaseId ?? newLeaseId)();
  const claimed = await claimLease(db, id, { leaseId, untilMs: now + leaseMsFor(template) }, now);
  if (!claimed) return { status: 409, body: { error: "The job is running", code: "running" } };
  try {
    await deps.startManualRun({ kind: "run", enrollmentId: id, leaseId });
  } catch (err) {
    console.error(`[jobs] handing manual run ${id} to the dispatcher failed:`, err);
    await recordOutcome(
      db,
      id,
      leaseId,
      { status: "failed", message: "The job could not start. Try again." },
      (deps.now ?? Date.now)(),
    );
    return { status: 503, body: { error: "The job could not start. Try again." } };
  }
  return { status: 202, body: { runId: leaseId } };
}
