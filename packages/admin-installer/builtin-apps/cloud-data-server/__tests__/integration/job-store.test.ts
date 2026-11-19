/**
 * The job enrollment store's SQL on one real Postgres: the upsert, the lease
 * claim and its race, the due query, outcomes and stops.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import {
  claimLease,
  dueEnrollments,
  enrollmentId,
  findEnrollment,
  listEnrollments,
  liveLeaseCount,
  recordOutcome,
  revokeEnrollment,
  setSchedule,
  stopEnrollment,
  upsertEnrollment,
  type NewEnrollment,
} from "../../src/job-store.js";
import { createSharedSchema } from "../../../../../storage-aurora-dsql/__tests__/pg-shared-schema.js";
import { dropAllUserSchemas } from "../../../../../storage-aurora-dsql/__tests__/pglite-reset.js";

let pg: PGlite;
let client: DatabaseClient;
const NOW = 1_800_000_000_000;

function enrollment(over: Partial<NewEnrollment> = {}): NewEnrollment {
  const user = over.user_id ?? "user-a";
  const app = over.app_id ?? "probe";
  const job = over.job ?? "tick";
  return {
    id: enrollmentId(user, app, job),
    user_id: user,
    app_id: app,
    job,
    mode: "readwrite",
    time_zone: "UTC",
    time_of_day: "06:00",
    cognito_refresh_ciphertext: "sealed",
    next_due_at_ms: NOW - 1000,
    ...over,
  };
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  client = {
    async query(text, values) {
      const result = await pg.query(text, values as unknown[] | undefined);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    async end() {},
  };
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await dropAllUserSchemas(pg);
  await createSharedSchema(pg);
});

describe("enrollmentId", () => {
  it("is stable and distinct per user, app and job", () => {
    expect(enrollmentId("u", "a", "j")).toBe(enrollmentId("u", "a", "j"));
    expect(enrollmentId("u", "a", "j")).not.toBe(enrollmentId("u", "a", "k"));
    expect(enrollmentId("u", "a", "j")).not.toBe(enrollmentId("v", "a", "j"));
    expect(enrollmentId("u", "a", "j")).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("the job store", () => {
  it("re-enables a revoked enrollment in place with the new choices", async () => {
    const e = enrollment();
    await upsertEnrollment(client, e, NOW);
    await recordOutcome(client, e.id, "none", { status: "ok", message: null }, NOW);
    expect(await revokeEnrollment(client, "user-a", e.id, NOW)).not.toBeNull();
    expect((await findEnrollment(client, e.id))?.next_due_at_ms).toBeNull();
    await stopEnrollment(client, e.id, "signed-out", "x", NOW);

    await upsertEnrollment(
      client,
      {
        ...e,
        mode: "read",
        time_of_day: null,
        next_due_at_ms: null,
        cognito_refresh_ciphertext: "new",
      },
      NOW + 5,
    );
    const row = (await findEnrollment(client, e.id))!;
    expect(row).toMatchObject({
      mode: "read",
      time_of_day: null,
      revoked_at_ms: null,
      cognito_refresh_ciphertext: "new",
      created_at_ms: NOW,
      updated_at_ms: NOW + 5,
      attention: null,
      failures: 0,
    });
  });

  it("revokes and re-times only the owner's live enrollment", async () => {
    const e = enrollment();
    await upsertEnrollment(client, e, NOW);
    const schedule = { timeZone: "Europe/London", timeOfDay: "07:15", nextDueAtMs: NOW + 99 };
    expect(await setSchedule(client, "user-b", e.id, schedule, NOW)).toBeNull();
    expect(await setSchedule(client, "user-a", e.id, schedule, NOW)).toMatchObject({
      time_zone: "Europe/London",
      time_of_day: "07:15",
      next_due_at_ms: NOW + 99,
    });
    expect(await revokeEnrollment(client, "user-b", e.id, NOW)).toBeNull();
    expect(await revokeEnrollment(client, "user-a", e.id, NOW)).not.toBeNull();
    expect(await revokeEnrollment(client, "user-a", e.id, NOW)).toBeNull();
    expect(await setSchedule(client, "user-a", e.id, schedule, NOW)).toBeNull();
  });

  it("lists one user's enrollments, optionally for one app", async () => {
    await upsertEnrollment(client, enrollment({ job: "b" }), NOW);
    await upsertEnrollment(client, enrollment({ job: "a" }), NOW);
    await upsertEnrollment(client, enrollment({ app_id: "other" }), NOW);
    await upsertEnrollment(client, enrollment({ user_id: "user-b" }), NOW);
    expect((await listEnrollments(client, "user-a")).map((r) => `${r.app_id}/${r.job}`)).toEqual([
      "other/tick",
      "probe/a",
      "probe/b",
    ]);
    expect((await listEnrollments(client, "user-a", "probe")).map((r) => r.job)).toEqual([
      "a",
      "b",
    ]);
  });

  it("lets one of two concurrent claims win, and advances the schedule with it", async () => {
    const e = enrollment();
    await upsertEnrollment(client, e, NOW);
    const [first, second] = await Promise.all([
      claimLease(
        client,
        e.id,
        { leaseId: "L1", untilMs: NOW + 60_000, nextDueAtMs: NOW + 86_400_000 },
        NOW,
      ),
      claimLease(
        client,
        e.id,
        { leaseId: "L2", untilMs: NOW + 60_000, nextDueAtMs: NOW + 86_400_000 },
        NOW,
      ),
    ]);
    const winners = [first, second].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const row = (await findEnrollment(client, e.id))!;
    expect(row.lease_id).toBe(winners[0]!.lease_id);
    expect(row.next_due_at_ms).toBe(NOW + 86_400_000);
    expect(row.last_started_at_ms).toBe(NOW);
    expect(await liveLeaseCount(client, NOW)).toBe(1);
    // Once the lease ends, another run may claim it.
    expect(
      await claimLease(client, e.id, { leaseId: "L3", untilMs: NOW + 120_001 }, NOW + 60_000),
    ).not.toBeNull();
  });

  it("leaves the schedule alone on a manual claim, and refuses a revoked enrollment", async () => {
    const e = enrollment({ next_due_at_ms: null, time_of_day: null });
    await upsertEnrollment(client, e, NOW);
    const row = await claimLease(client, e.id, { leaseId: "L1", untilMs: NOW + 10 }, NOW);
    expect(row?.next_due_at_ms).toBeNull();
    await revokeEnrollment(client, "user-a", e.id, NOW);
    expect(
      await claimLease(client, e.id, { leaseId: "L2", untilMs: NOW + 99 }, NOW + 50),
    ).toBeNull();
  });

  it("finds due enrollments that no run holds, soonest first", async () => {
    const early = enrollment({ job: "early", next_due_at_ms: NOW - 5000 });
    const late = enrollment({ job: "late", next_due_at_ms: NOW - 10 });
    const future = enrollment({ job: "future", next_due_at_ms: NOW + 10 });
    const manual = enrollment({ job: "manual", next_due_at_ms: null });
    const held = enrollment({ job: "held", next_due_at_ms: NOW - 1 });
    const off = enrollment({ job: "off", next_due_at_ms: NOW - 1 });
    for (const e of [late, early, future, manual, held, off])
      await upsertEnrollment(client, e, NOW);
    await claimLease(client, held.id, { leaseId: "L", untilMs: NOW + 1000 }, NOW - 100);
    await revokeEnrollment(client, "user-a", off.id, NOW);
    // The revoke cleared the due time; put one back to check the revoked filter.
    await pg.query(`UPDATE delegation.jobs SET next_due_at_ms = $1 WHERE id = $2`, [
      NOW - 1,
      off.id,
    ]);
    expect((await dueEnrollments(client, NOW, 10)).map((r) => r.job)).toEqual(["early", "late"]);
    expect((await dueEnrollments(client, NOW, 1)).map((r) => r.job)).toEqual(["early"]);
  });

  it("records each outcome and releases the lease, only for the run that holds it", async () => {
    const e = enrollment();
    await upsertEnrollment(client, e, NOW);
    await claimLease(
      client,
      e.id,
      { leaseId: "L1", untilMs: NOW + 1000, nextDueAtMs: NOW + 9 },
      NOW,
    );
    expect(await recordOutcome(client, e.id, "other", { status: "ok", message: null }, NOW)).toBe(
      false,
    );
    expect(
      await recordOutcome(
        client,
        e.id,
        "L1",
        { status: "failed", message: "x".repeat(600) },
        NOW + 1,
      ),
    ).toBe(true);
    let row = (await findEnrollment(client, e.id))!;
    expect(row).toMatchObject({
      lease_id: null,
      lease_until_ms: null,
      last_status: "failed",
      attention: "failed",
      failures: 1,
      last_finished_at_ms: NOW + 1,
      next_due_at_ms: NOW + 9,
    });
    expect(row.last_message).toHaveLength(500);

    await claimLease(client, e.id, { leaseId: "L2", untilMs: NOW + 1000 }, NOW + 2);
    await recordOutcome(client, e.id, "L2", { status: "failed", message: null }, NOW + 3);
    expect((await findEnrollment(client, e.id))!.failures).toBe(2);

    await claimLease(client, e.id, { leaseId: "L3", untilMs: NOW + 1000 }, NOW + 4);
    await recordOutcome(client, e.id, "L3", { status: "deferred", message: "throttled" }, NOW + 5);
    row = (await findEnrollment(client, e.id))!;
    expect(row).toMatchObject({
      last_status: "deferred",
      attention: "failed",
      failures: 2,
      next_due_at_ms: NOW + 5,
    });

    await claimLease(client, e.id, { leaseId: "L4", untilMs: NOW + 1000 }, NOW + 6);
    await recordOutcome(client, e.id, "L4", { status: "ok", message: "3 workouts" }, NOW + 7);
    row = (await findEnrollment(client, e.id))!;
    expect(row).toMatchObject({
      last_status: "ok",
      attention: null,
      failures: 0,
      last_message: "3 workouts",
    });
  });

  it("stops an enrollment: no due time, no lease, and the reason", async () => {
    const e = enrollment();
    await upsertEnrollment(client, e, NOW);
    await claimLease(client, e.id, { leaseId: "L1", untilMs: NOW + 1000 }, NOW);
    await stopEnrollment(client, e.id, "needs-consent", "The app changed this job.", NOW + 1);
    expect(await findEnrollment(client, e.id)).toMatchObject({
      attention: "needs-consent",
      last_status: "stopped",
      next_due_at_ms: null,
      lease_id: null,
      revoked_at_ms: null,
    });
    expect(await dueEnrollments(client, NOW + 10_000_000_000, 10)).toEqual([]);
  });
});
