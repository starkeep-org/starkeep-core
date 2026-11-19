/**
 * The job dispatcher: runs each due job enrollment by invoking the app's
 * function with a `job` token for that enrollment's user.
 *
 * Two events reach it:
 *
 * - **A tick** from the EventBridge rule `<prefix>-jobs-tick`, every five
 *   minutes. The dispatcher reads the due enrollments and runs as many as
 *   the free slots allow ({@link JOB_SLOTS} across the deployment, less the
 *   runs already holding a lease). The rest wait for the next tick.
 * - **A manual run**, `{ kind: "run", enrollmentId, leaseId }`, which the
 *   data server sends asynchronously after it claimed the lease for a user's
 *   "run now". The dispatcher runs the enrollment only while that lease
 *   still holds.
 *
 * For each enrollment, the dispatcher checks the app's manifest still offers
 * the job as the user approved it, claims the lease, checks the user through
 * the stored Cognito refresh token, mints a token that expires with the
 * lease, invokes `<prefix>-app-<appId>-<handler>` with
 * `POST /apps/<appId>/_starkeep/jobs/<job>`, records the outcome and
 * releases the lease.
 *
 * The dispatcher shares the data server's role and bundle. The role already
 * holds the delegation signing key, so invoking an app's function gives it
 * no reach a token it could mint would not already give it.
 *
 * Pacing is a soft bound: DSQL's optimistic concurrency can let two
 * overlapping dispatchers each see one free slot.
 */
import { randomBytes } from "node:crypto";
import {
  JOB_LEASE_MARGIN_S,
  JOB_ROUTE_PREFIX,
  JOB_SLOTS,
  type DelegationMode,
} from "@starkeep/protocol-primitives";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import {
  openRefreshToken,
  signDelegationToken,
  type DelegationSigningKey,
} from "./delegation-tokens.js";
import type { UserCheck } from "./delegation-user-check.js";
import { nextDueAt } from "./job-schedule.js";
import {
  boundedMessage,
  claimLease,
  dueEnrollments,
  findEnrollment,
  leaseIsLive,
  liveLeaseCount,
  recordOutcome,
  stopEnrollment,
  type JobOutcome,
  type JobRow,
} from "./job-store.js";
import { loadJobApp, runMode, type JobApp, type JobTemplate } from "./job-manifest.js";
import { NEEDS_CONSENT_MESSAGE, NO_LIBRARY_MESSAGE, SIGNED_OUT_MESSAGE } from "./job-messages.js";

/** How many due enrollments one tick reads. */
const DUE_BATCH = 10;

/** What the app's function answered, or why the invoke failed. */
export type InvokeResult =
  | { kind: "answered"; statusCode: number; body: string }
  /** The function threw, timed out or returned something that is not a response. */
  | { kind: "function-error"; message: string }
  /** Lambda refused the invoke for concurrency: not the app's fault. */
  | { kind: "throttled" }
  | { kind: "invoke-error"; message: string };

export interface DispatcherDeps {
  /** A database client as the platform's standing identity. */
  db(): Promise<DatabaseClient>;
  signingKey(): Promise<DelegationSigningKey | null>;
  checkUser(enrollmentId: string, userId: string, refreshToken: string): Promise<UserCheck>;
  /** Invoke one function synchronously, waiting at least `timeoutMs`. */
  invoke(functionName: string, event: unknown, timeoutMs: number): Promise<InvokeResult>;
  stackPrefix: string;
  /** The deployment's browser-facing host, which the app's event names. */
  publicHost(): Promise<string>;
  now?: () => number;
  newLeaseId?: () => string;
}

/** A manual run the data server hands over after claiming its lease. */
export interface ManualRunEvent {
  kind: "run";
  enrollmentId: string;
  leaseId: string;
}

export function isManualRunEvent(event: unknown): event is ManualRunEvent {
  const e = event as Partial<ManualRunEvent> | null;
  return (
    typeof e === "object" &&
    e !== null &&
    e.kind === "run" &&
    typeof e.enrollmentId === "string" &&
    typeof e.leaseId === "string"
  );
}

export function newLeaseId(): string {
  return randomBytes(16).toString("base64url");
}

/** How long a run of `template` may hold its lease. */
export function leaseMsFor(template: JobTemplate): number {
  return (template.timeoutSeconds + JOB_LEASE_MARGIN_S) * 1000;
}

/** The enrollment's next scheduled firing after `nowMs`, or null for a manual-only job. */
export function nextFiring(row: Pick<JobRow, "time_zone" | "time_of_day">, nowMs: number) {
  return row.time_of_day ? nextDueAt(row.time_zone, row.time_of_day, nowMs) : null;
}

/** The job a template names on an app, or null when the app no longer offers it. */
export function templateFor(app: JobApp | null, job: string): JobTemplate | null {
  return app?.jobs.find((j) => j.name === job) ?? null;
}

/** The function name the installer gives an app's compute handler. */
export function functionNameFor(stackPrefix: string, appId: string, handler: string): string {
  return `${stackPrefix}-app-${appId}-${handler}`;
}

/** The API Gateway v2 event the app's function receives for one run. */
export function jobEvent(args: {
  appId: string;
  job: string;
  token: string;
  host: string;
  runId: string;
  trigger: "schedule" | "manual";
  scheduledFor: number | null;
  nowMs: number;
}): Record<string, unknown> {
  const rawPath = `/apps/${args.appId}${JOB_ROUTE_PREFIX}${args.job}`;
  return {
    version: "2.0",
    routeKey: `POST ${rawPath}`,
    rawPath,
    rawQueryString: "",
    headers: {
      authorization: `Bearer ${args.token}`,
      host: args.host,
      "content-type": "application/json",
      "x-forwarded-proto": "https",
    },
    requestContext: {
      domainName: args.host,
      http: { method: "POST", path: rawPath, protocol: "HTTP/1.1", sourceIp: "", userAgent: "" },
      requestId: args.runId,
      routeKey: `POST ${rawPath}`,
      stage: "$default",
      timeEpoch: args.nowMs,
    },
    body: JSON.stringify({
      job: args.job,
      runId: args.runId,
      trigger: args.trigger,
      scheduledFor: args.scheduledFor,
    }),
    isBase64Encoded: false,
  };
}

/** The outcome an invoke result records. */
export function outcomeOf(result: InvokeResult): JobOutcome {
  switch (result.kind) {
    case "answered": {
      let message: string | null = null;
      try {
        const parsed = JSON.parse(result.body) as { message?: unknown };
        message = typeof parsed?.message === "string" ? parsed.message : null;
      } catch {
        // A body that is not JSON carries no message.
      }
      if (result.statusCode >= 200 && result.statusCode < 300) return { status: "ok", message };
      return { status: "failed", message: message ?? `The app answered ${result.statusCode}.` };
    }
    case "function-error":
      return { status: "failed", message: `The app's function failed: ${result.message}` };
    case "throttled":
      return { status: "deferred", message: "The cloud was busy. The job runs on the next tick." };
    case "invoke-error":
      return { status: "failed", message: `The job could not start: ${result.message}` };
  }
}

/** What one run did, for the log line and the tests. */
export interface RunReport {
  enrollmentId: string;
  appId: string;
  job: string;
  outcome: JobOutcome["status"] | "stopped" | "skipped";
  durationMs: number;
}

class Dispatcher {
  private readonly now: () => number;
  private readonly lease: () => string;
  private readonly apps = new Map<string, Promise<JobApp | null>>();
  private client: Promise<DatabaseClient> | null = null;

  constructor(private readonly deps: DispatcherDeps) {
    this.now = deps.now ?? Date.now;
    this.lease = deps.newLeaseId ?? newLeaseId;
  }

  db(): Promise<DatabaseClient> {
    return (this.client ??= this.deps.db());
  }

  app(appId: string): Promise<JobApp | null> {
    let app = this.apps.get(appId);
    if (!app) {
      app = this.db().then((db) => loadJobApp(db, appId));
      this.apps.set(appId, app);
    }
    return app;
  }

  /** The template and the run's mode, or null after stopping the enrollment. */
  async admitTemplate(
    row: JobRow,
  ): Promise<{ template: JobTemplate; mode: DelegationMode } | null> {
    const template = templateFor(await this.app(row.app_id), row.job);
    const mode = template ? runMode(row.mode, template) : null;
    if (!template || !mode) {
      await stopEnrollment(
        await this.db(),
        row.id,
        "needs-consent",
        NEEDS_CONSENT_MESSAGE,
        this.now(),
      );
      return null;
    }
    return { template, mode };
  }

  async tick(): Promise<RunReport[]> {
    const db = await this.db();
    const now = this.now();
    const due = await dueEnrollments(db, now, DUE_BATCH);
    if (due.length === 0) return [];
    const free = JOB_SLOTS - (await liveLeaseCount(db, now));
    if (free <= 0) return [];
    return await Promise.all(due.slice(0, free).map((row) => this.scheduled(row)));
  }

  async scheduled(row: JobRow): Promise<RunReport> {
    const started = this.now();
    const admitted = await this.admitTemplate(row);
    if (!admitted) return this.report(row, "stopped", started);
    const leaseId = this.lease();
    const claimed = await claimLease(
      await this.db(),
      row.id,
      {
        leaseId,
        untilMs: started + leaseMsFor(admitted.template),
        nextDueAtMs: nextFiring(row, started),
      },
      started,
    );
    // Another run holds it, or the user turned it off since the due query.
    if (!claimed) return this.report(row, "skipped", started);
    return await this.execute(claimed, admitted, "schedule", row.next_due_at_ms, started);
  }

  async manual(event: ManualRunEvent): Promise<RunReport | null> {
    const started = this.now();
    const row = await findEnrollment(await this.db(), event.enrollmentId);
    if (
      !row ||
      row.revoked_at_ms !== null ||
      row.lease_id !== event.leaseId ||
      !leaseIsLive(row, started)
    ) {
      console.warn(`[jobs] manual run ${event.enrollmentId} lost its lease before it started`);
      return null;
    }
    const admitted = await this.admitTemplate(row);
    if (!admitted) return this.report(row, "stopped", started);
    return await this.execute(row, admitted, "manual", null, started);
  }

  /** Run one claimed enrollment and record what happened. */
  async execute(
    row: JobRow,
    admitted: { template: JobTemplate; mode: DelegationMode },
    trigger: "schedule" | "manual",
    scheduledFor: number | null,
    started: number,
  ): Promise<RunReport> {
    const leaseId = row.lease_id!;
    const leaseUntil = row.lease_until_ms!;
    const db = await this.db();
    try {
      const key = await this.deps.signingKey();
      if (!key) {
        return await this.finish(row, leaseId, started, {
          status: "deferred",
          message: "Scheduled jobs are not set up on this cloud yet.",
        });
      }
      const refresh = openRefreshToken(key.refreshKey, row.id, row.cognito_refresh_ciphertext);
      const check: UserCheck = refresh
        ? await this.deps.checkUser(row.id, row.user_id, refresh)
        : { ok: false, reason: "refused" };
      if (!check.ok) {
        if (check.reason === "unavailable") {
          return await this.finish(row, leaseId, started, {
            status: "deferred",
            message: "Sign-in was unavailable. The job runs on the next tick.",
          });
        }
        const signedOut = check.reason === "refused";
        await stopEnrollment(
          db,
          row.id,
          signedOut ? "signed-out" : "no-library",
          signedOut ? SIGNED_OUT_MESSAGE : NO_LIBRARY_MESSAGE,
          this.now(),
        );
        return this.report(row, "stopped", started);
      }

      const token = signDelegationToken(key, {
        userId: row.user_id,
        appId: row.app_id,
        delegationId: row.id,
        mode: admitted.mode,
        channel: "job",
        job: { name: row.job, runId: leaseId },
        expiresAtMs: leaseUntil,
        nowMs: this.now(),
      });
      const event = jobEvent({
        appId: row.app_id,
        job: row.job,
        token,
        host: await this.deps.publicHost(),
        runId: leaseId,
        trigger,
        scheduledFor,
        nowMs: this.now(),
      });
      const result = await this.deps.invoke(
        functionNameFor(this.deps.stackPrefix, row.app_id, admitted.template.handler),
        event,
        // Past the app's own timeout, so the app's answer always arrives.
        (admitted.template.timeoutSeconds + 30) * 1000,
      );
      return await this.finish(row, leaseId, started, outcomeOf(result));
    } catch (err) {
      console.error(`[jobs] run ${row.id} failed in the dispatcher:`, err);
      return await this.finish(row, leaseId, started, {
        status: "failed",
        message: boundedMessage(`The dispatcher failed: ${(err as Error)?.message ?? String(err)}`),
      });
    }
  }

  async finish(row: JobRow, leaseId: string, started: number, outcome: JobOutcome) {
    const recorded = await recordOutcome(await this.db(), row.id, leaseId, outcome, this.now());
    if (!recorded) console.warn(`[jobs] run ${row.id} lost its lease before it finished`);
    return this.report(row, outcome.status, started);
  }

  report(row: JobRow, outcome: RunReport["outcome"], started: number): RunReport {
    const report: RunReport = {
      enrollmentId: row.id,
      appId: row.app_id,
      job: row.job,
      outcome,
      durationMs: this.now() - started,
    };
    // One line per run. Never the token.
    console.log(
      `[jobs] enrollment=${report.enrollmentId} app=${report.appId} job=${report.job} ` +
        `outcome=${report.outcome} durationMs=${report.durationMs}`,
    );
    return report;
  }
}

/** Answer one dispatcher event: a tick or a manual run. */
export async function dispatch(event: unknown, deps: DispatcherDeps): Promise<RunReport[]> {
  const dispatcher = new Dispatcher(deps);
  if (isManualRunEvent(event)) {
    const report = await dispatcher.manual(event);
    return report ? [report] : [];
  }
  return await dispatcher.tick();
}
