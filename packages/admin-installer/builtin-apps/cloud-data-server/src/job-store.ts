/**
 * Job enrollments: one user's approval for one app's scheduled job to run
 * with that user's authority, and the job's schedule and last run.
 *
 * The table sits beside `delegation.grants`, outside the owner-scope
 * compiler, for the same reason: a `job` token names its row, and the data
 * server finds the row before the row names a user. Every read here
 * therefore takes the id, the user or both, and the callers compare the row
 * with the token's claims.
 *
 * Each row keeps a Cognito refresh token from the connectors client, sealed
 * with the row's id as associated data, as a delegation does. The dispatcher
 * and the data server mint ID tokens from it to learn whether the user may
 * still use data, so "Sign out all devices", "Disable" and removal from
 * `starkeep-users` stop a user's jobs with no hook here.
 *
 * A run holds a lease: `lease_id` and `lease_until_ms`. {@link claimLease}
 * sets both with a conditional UPDATE, so only one run of an enrollment is
 * live at a time, and a `job` token works only while its run's lease does.
 * A rotating third-party credential, such as a refresh token that its
 * provider revokes when an old one reappears, therefore never sees two
 * overlapping runs.
 */
import { createHash } from "node:crypto";
import type { DelegationMode } from "@starkeep/protocol-primitives";
import {
  isRetryableDsqlConflict,
  postgresCompiler,
  type DatabaseClient,
} from "@starkeep/storage-aurora-dsql";

const JOBS_TABLE = "delegation.jobs";

/** The longest `last_message` the row keeps. */
export const MAX_JOB_MESSAGE = 500;

/** Why a job stopped or needs the user. Null when healthy. */
export type JobAttention = "failed" | "signed-out" | "no-library" | "needs-consent";

/** How the last run ended. */
export type JobStatus = "ok" | "failed" | "deferred" | "stopped";

export interface JobRow {
  id: string;
  user_id: string;
  app_id: string;
  job: string;
  mode: DelegationMode;
  /** An IANA zone. */
  time_zone: string;
  /** `HH:MM` in `time_zone`, or null for a job that runs only when the user asks. */
  time_of_day: string | null;
  cognito_refresh_ciphertext: string;
  created_at_ms: number;
  updated_at_ms: number;
  revoked_at_ms: number | null;
  next_due_at_ms: number | null;
  lease_id: string | null;
  lease_until_ms: number | null;
  last_started_at_ms: number | null;
  last_finished_at_ms: number | null;
  last_status: JobStatus | null;
  last_message: string | null;
  attention: JobAttention | null;
  failures: number;
}

const COLUMNS = [
  "id",
  "user_id",
  "app_id",
  "job",
  "mode",
  "time_zone",
  "time_of_day",
  "cognito_refresh_ciphertext",
  "created_at_ms",
  "updated_at_ms",
  "revoked_at_ms",
  "next_due_at_ms",
  "lease_id",
  "lease_until_ms",
  "last_started_at_ms",
  "last_finished_at_ms",
  "last_status",
  "last_message",
  "attention",
  "failures",
] as const;

type Db = Record<string, Record<string, unknown>>;
const compiler = postgresCompiler as unknown as import("kysely").Kysely<Db>;

async function run(
  client: DatabaseClient,
  compiled: { sql: string; parameters: readonly unknown[] },
): Promise<Record<string, unknown>[]> {
  const result = await client.query(compiled.sql, [...compiled.parameters]);
  return result.rows as Record<string, unknown>[];
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rowOf(raw: Record<string, unknown>): JobRow {
  return {
    ...(raw as unknown as JobRow),
    time_of_day: nullableString(raw.time_of_day),
    // `bigint` comes back from `pg` as a string.
    created_at_ms: Number(raw.created_at_ms),
    updated_at_ms: Number(raw.updated_at_ms),
    revoked_at_ms: nullableNumber(raw.revoked_at_ms),
    next_due_at_ms: nullableNumber(raw.next_due_at_ms),
    lease_id: nullableString(raw.lease_id),
    lease_until_ms: nullableNumber(raw.lease_until_ms),
    last_started_at_ms: nullableNumber(raw.last_started_at_ms),
    last_finished_at_ms: nullableNumber(raw.last_finished_at_ms),
    last_status: nullableString(raw.last_status) as JobStatus | null,
    last_message: nullableString(raw.last_message),
    attention: nullableString(raw.attention) as JobAttention | null,
    failures: Number(raw.failures ?? 0),
  };
}

/** A message cut to {@link MAX_JOB_MESSAGE} characters, or null. */
export function boundedMessage(message: unknown): string | null {
  if (typeof message !== "string" || message.length === 0) return null;
  return message.length > MAX_JOB_MESSAGE ? message.slice(0, MAX_JOB_MESSAGE) : message;
}

/**
 * The enrollment id for one user, app and job: stable, so turning a job off
 * and on again reuses its row, and the table needs no unique index.
 */
export function enrollmentId(userId: string, appId: string, job: string): string {
  return createHash("sha256")
    .update(`${userId}\n${appId}\n${job}`)
    .digest("base64url")
    .slice(0, 22);
}

/** Whether a row holds a live lease at `nowMs`. */
export function leaseIsLive(row: JobRow, nowMs: number): boolean {
  return row.lease_id !== null && row.lease_until_ms !== null && row.lease_until_ms > nowMs;
}

/** What the consent page's approval writes. */
export interface NewEnrollment {
  id: string;
  user_id: string;
  app_id: string;
  job: string;
  mode: DelegationMode;
  time_zone: string;
  time_of_day: string | null;
  cognito_refresh_ciphertext: string;
  next_due_at_ms: number | null;
}

/**
 * Create the enrollment, or turn an existing one back on with the user's new
 * choices and a fresh refresh token. A reused row keeps its last run and its
 * lease, so a run already under way finishes under its own lease.
 */
export async function upsertEnrollment(
  client: DatabaseClient,
  e: NewEnrollment,
  nowMs: number,
): Promise<void> {
  const fresh = {
    mode: e.mode,
    time_zone: e.time_zone,
    time_of_day: e.time_of_day,
    cognito_refresh_ciphertext: e.cognito_refresh_ciphertext,
    updated_at_ms: nowMs,
    revoked_at_ms: null,
    next_due_at_ms: e.next_due_at_ms,
    attention: null,
    failures: 0,
  };
  await run(
    client,
    compiler
      .insertInto(JOBS_TABLE)
      .values({
        id: e.id,
        user_id: e.user_id,
        app_id: e.app_id,
        job: e.job,
        created_at_ms: nowMs,
        ...fresh,
      })
      .onConflict((oc) => oc.column("id").doUpdateSet(fresh))
      .compile(),
  );
}

/** The row an id names, or null. The caller compares the user, the app and the job. */
export async function findEnrollment(client: DatabaseClient, id: string): Promise<JobRow | null> {
  const rows = await run(
    client,
    compiler
      .selectFrom(JOBS_TABLE)
      .select([...COLUMNS])
      .where("id", "=", id)
      .compile(),
  );
  return rows[0] ? rowOf(rows[0]) : null;
}

/** One user's enrollments, optionally for one app, oldest first. */
export async function listEnrollments(
  client: DatabaseClient,
  userId: string,
  appId?: string,
): Promise<JobRow[]> {
  let q = compiler
    .selectFrom(JOBS_TABLE)
    .select([...COLUMNS])
    .where("user_id", "=", userId);
  if (appId !== undefined) q = q.where("app_id", "=", appId);
  const rows = await run(client, q.orderBy("app_id").orderBy("job").compile());
  return rows.map(rowOf);
}

/**
 * Turn one of the user's enrollments off. Returns the row as it stood, or
 * null when the user has no such live enrollment.
 */
export async function revokeEnrollment(
  client: DatabaseClient,
  userId: string,
  id: string,
  nowMs: number,
): Promise<JobRow | null> {
  const rows = await run(
    client,
    compiler
      .updateTable(JOBS_TABLE)
      .set({ revoked_at_ms: nowMs, next_due_at_ms: null, updated_at_ms: nowMs })
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .where("revoked_at_ms", "is", null)
      .returning([...COLUMNS])
      .compile(),
  );
  return rows[0] ? rowOf(rows[0]) : null;
}

/**
 * Change one of the user's live enrollments' schedule. Returns the updated
 * row, or null when the user has no such live enrollment.
 */
export async function setSchedule(
  client: DatabaseClient,
  userId: string,
  id: string,
  schedule: { timeZone: string; timeOfDay: string | null; nextDueAtMs: number | null },
  nowMs: number,
): Promise<JobRow | null> {
  const rows = await run(
    client,
    compiler
      .updateTable(JOBS_TABLE)
      .set({
        time_zone: schedule.timeZone,
        time_of_day: schedule.timeOfDay,
        next_due_at_ms: schedule.nextDueAtMs,
        updated_at_ms: nowMs,
      })
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .where("revoked_at_ms", "is", null)
      .returning([...COLUMNS])
      .compile(),
  );
  return rows[0] ? rowOf(rows[0]) : null;
}

/**
 * The enrollments due at `nowMs` that no run holds, soonest first. A stopped
 * enrollment has no due time, so it never appears.
 */
export async function dueEnrollments(
  client: DatabaseClient,
  nowMs: number,
  limit: number,
): Promise<JobRow[]> {
  const rows = await run(
    client,
    compiler
      .selectFrom(JOBS_TABLE)
      .select([...COLUMNS])
      .where("next_due_at_ms", "<=", nowMs)
      .where("revoked_at_ms", "is", null)
      .where((eb) => eb.or([eb("lease_until_ms", "is", null), eb("lease_until_ms", "<=", nowMs)]))
      .orderBy("next_due_at_ms")
      .limit(limit)
      .compile(),
  );
  return rows.map(rowOf);
}

/** How many runs hold a live lease at `nowMs`, across the deployment. */
export async function liveLeaseCount(client: DatabaseClient, nowMs: number): Promise<number> {
  const rows = await run(
    client,
    compiler
      .selectFrom(JOBS_TABLE)
      .select((eb) => eb.fn.countAll().as("n"))
      .where("lease_until_ms", ">", nowMs)
      .compile(),
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Claim a run of one live enrollment that no run holds. `nextDueAtMs`, when
 * given, moves the next firing forward in the same statement, so a run that
 * crashes before it records an outcome does not refire on every tick. A
 * manual run leaves the schedule alone. Returns the claimed row, or null when
 * another run holds the lease, the enrollment is off, or a concurrent claim
 * won: DSQL's optimistic concurrency reports that last case as a conflict,
 * which here means only "someone else has it".
 */
export async function claimLease(
  client: DatabaseClient,
  id: string,
  lease: { leaseId: string; untilMs: number; nextDueAtMs?: number | null },
  nowMs: number,
): Promise<JobRow | null> {
  const set: Record<string, unknown> = {
    lease_id: lease.leaseId,
    lease_until_ms: lease.untilMs,
    last_started_at_ms: nowMs,
  };
  if (lease.nextDueAtMs !== undefined) set.next_due_at_ms = lease.nextDueAtMs;
  try {
    const rows = await run(
      client,
      compiler
        .updateTable(JOBS_TABLE)
        .set(set)
        .where("id", "=", id)
        .where("revoked_at_ms", "is", null)
        .where((eb) => eb.or([eb("lease_until_ms", "is", null), eb("lease_until_ms", "<=", nowMs)]))
        .returning([...COLUMNS])
        .compile(),
    );
    return rows[0] ? rowOf(rows[0]) : null;
  } catch (err) {
    if (isRetryableDsqlConflict(err)) return null;
    throw err;
  }
}

/** How one run ended, as the dispatcher records it. */
export type JobOutcome =
  | { status: "ok"; message: string | null }
  | { status: "failed"; message: string | null }
  /** Not run, through no fault of the app: retried on the next tick. */
  | { status: "deferred"; message: string | null };

/**
 * Record a run's outcome and release its lease. Only the run that holds the
 * lease records, so a run whose lease expired and passed to another run
 * leaves the newer run's row alone. Returns false when the lease had moved.
 *
 * - `ok` clears `attention` and the failure count.
 * - `failed` sets `attention` to `failed` and counts the failure.
 * - `deferred` makes the enrollment due again, for the next tick.
 */
export async function recordOutcome(
  client: DatabaseClient,
  id: string,
  leaseId: string,
  outcome: JobOutcome,
  nowMs: number,
): Promise<boolean> {
  const set: Record<string, unknown> = {
    lease_id: null,
    lease_until_ms: null,
    last_finished_at_ms: nowMs,
    last_status: outcome.status,
    last_message: boundedMessage(outcome.message),
  };
  if (outcome.status === "ok") {
    set.attention = null;
    set.failures = 0;
  } else if (outcome.status === "failed") {
    set.attention = "failed";
  } else {
    set.next_due_at_ms = nowMs;
  }
  const rows = await run(
    client,
    compiler
      .updateTable(JOBS_TABLE)
      .set((eb) =>
        outcome.status === "failed" ? { ...set, failures: eb("failures", "+", 1) } : set,
      )
      .where("id", "=", id)
      .where("lease_id", "=", leaseId)
      .where("revoked_at_ms", "is", null)
      .returning(["id"])
      .compile(),
  );
  return rows.length === 1;
}

/**
 * Stop one enrollment until the user turns it on again: the user signed out
 * or lost the data library, or the app's manifest no longer offers the job
 * as the user approved it. The row keeps its refresh token, stays listed
 * with the reason, and releases any lease.
 */
export async function stopEnrollment(
  client: DatabaseClient,
  id: string,
  attention: Exclude<JobAttention, "failed">,
  message: string,
  nowMs: number,
): Promise<void> {
  await run(
    client,
    compiler
      .updateTable(JOBS_TABLE)
      .set({
        attention,
        last_status: "stopped",
        last_message: boundedMessage(message),
        last_finished_at_ms: nowMs,
        next_due_at_ms: null,
        lease_id: null,
        lease_until_ms: null,
        updated_at_ms: nowMs,
      })
      .where("id", "=", id)
      .where("revoked_at_ms", "is", null)
      .compile(),
  );
}
