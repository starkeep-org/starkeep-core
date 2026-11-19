/**
 * The job dispatcher against one real Postgres, with fake Lambda and Cognito:
 * slots, skips, every outcome branch, the manifest check and manual runs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { JOB_SLOTS } from "@starkeep/protocol-primitives";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import {
  delegationPublicKeyFromPem,
  delegationSigningKeyFromPem,
  sealRefreshToken,
  verifyDelegationToken,
} from "../../src/delegation-tokens.js";
import type { UserCheck } from "../../src/delegation-user-check.js";
import { dispatch, type DispatcherDeps, type InvokeResult } from "../../src/dispatcher.js";
import {
  claimLease,
  enrollmentId,
  findEnrollment,
  upsertEnrollment,
  type JobRow,
} from "../../src/job-store.js";
import { makeDelegationKeyPem } from "../delegation-key.js";
import { createSharedSchema } from "../../../../../storage-aurora-dsql/__tests__/pg-shared-schema.js";
import { dropAllUserSchemas } from "../../../../../storage-aurora-dsql/__tests__/pglite-reset.js";

const pem = makeDelegationKeyPem();
const key = delegationSigningKeyFromPem(pem.privateKeyPem);
const publicKey = delegationPublicKeyFromPem(pem.publicKeyPem);
const NOW = Date.parse("2026-11-19T12:00:00Z");

let pg: PGlite;
let client: DatabaseClient;
let invokes: { functionName: string; event: Record<string, unknown>; timeoutMs: number }[];
let answer: (event: Record<string, unknown>) => InvokeResult | Promise<InvokeResult>;
let userCheck: UserCheck;
let leaseSeq: number;

function deps(over: Partial<DispatcherDeps> = {}): DispatcherDeps {
  return {
    db: async () => client,
    signingKey: async () => key,
    checkUser: async () => userCheck,
    invoke: async (functionName, event, timeoutMs) => {
      invokes.push({ functionName, event: event as Record<string, unknown>, timeoutMs });
      return answer(event as Record<string, unknown>);
    },
    stackPrefix: "teststack",
    publicHost: async () => "d111.cloudfront.net",
    now: () => NOW,
    newLeaseId: () => `lease-${++leaseSeq}`,
    ...over,
  };
}

function manifest(jobs: unknown[], over: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "probe",
    infraRequirements: {
      compute: { enabled: true, handlers: [{ name: "api", timeoutSeconds: 40 }] },
      jobs,
    },
    ...over,
  });
}
const TICK = {
  name: "tick",
  handler: "api",
  mode: "readwrite",
  defaultTime: null,
  description: "Ticks.",
};

async function install(jobs: unknown[] = [TICK], webApp = true) {
  await pg.query(
    `INSERT INTO shared.app_registry (app_id, version, name, web_app, manifest) VALUES ($1, '1', 'Probe', $2, $3)
     ON CONFLICT (app_id) DO UPDATE SET manifest = excluded.manifest, web_app = excluded.web_app`,
    ["probe", webApp, manifest(jobs)],
  );
}

async function enroll(over: Partial<JobRow> & { user_id?: string; job?: string } = {}) {
  const user = over.user_id ?? "user-a";
  const job = over.job ?? "tick";
  const id = enrollmentId(user, "probe", job);
  await upsertEnrollment(
    client,
    {
      id,
      user_id: user,
      app_id: "probe",
      job,
      mode: over.mode ?? "readwrite",
      time_zone: over.time_zone ?? "UTC",
      time_of_day: over.time_of_day === undefined ? "06:00" : over.time_of_day,
      cognito_refresh_ciphertext: sealRefreshToken(key.refreshKey, id, `refresh-${user}`),
      next_due_at_ms: over.next_due_at_ms === undefined ? NOW - 60_000 : over.next_due_at_ms,
    },
    NOW - 86_400_000,
  );
  return id;
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
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
  invokes = [];
  leaseSeq = 0;
  userCheck = { ok: true };
  answer = () => ({
    kind: "answered",
    statusCode: 200,
    body: JSON.stringify({ message: "3 new" }),
  });
  await install();
});

describe("a tick", () => {
  it("runs a due enrollment: the token, the event, the outcome and the next firing", async () => {
    const id = await enroll();
    const reports = await dispatch({ source: "aws.events" }, deps());
    expect(reports.map((r) => r.outcome)).toEqual(["ok"]);

    expect(invokes).toHaveLength(1);
    const { functionName, event, timeoutMs } = invokes[0]!;
    expect(functionName).toBe("teststack-app-probe-api");
    expect(timeoutMs).toBe(70_000);
    expect(event.rawPath).toBe("/apps/probe/_starkeep/jobs/tick");
    expect(event.requestContext).toMatchObject({ http: { method: "POST" } });
    const headers = event.headers as Record<string, string>;
    expect(headers.host).toBe("d111.cloudfront.net");
    expect(JSON.parse(event.body as string)).toEqual({
      job: "tick",
      runId: "lease-1",
      trigger: "schedule",
      scheduledFor: NOW - 60_000,
    });
    const claims = verifyDelegationToken(
      headers.authorization!.replace(/^Bearer /, ""),
      publicKey,
      NOW,
    );
    expect(claims).toMatchObject({
      sub: "user-a",
      aud: "probe",
      sk_dlg: id,
      sk_mode: "readwrite",
      sk_channel: "job",
      sk_job: "tick",
      sk_run: "lease-1",
      // The token ends with the lease: the handler's 40 s plus the margin.
      exp: Math.floor((NOW + 100_000) / 1000),
    });

    expect(await findEnrollment(client, id)).toMatchObject({
      last_status: "ok",
      last_message: "3 new",
      attention: null,
      lease_id: null,
      next_due_at_ms: Date.parse("2026-11-20T06:00:00Z"),
    });
  });

  it("runs no more than the free slots, soonest first, and leaves the rest due", async () => {
    const ids: string[] = [];
    for (let i = 0; i < JOB_SLOTS + 2; i++) {
      ids.push(await enroll({ user_id: `user-${i}`, next_due_at_ms: NOW - 1000 * (10 - i) }));
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    answer = async () => {
      started += 1;
      if (started === JOB_SLOTS) release();
      await gate;
      return { kind: "answered", statusCode: 200, body: "{}" };
    };
    const reports = await dispatch({}, deps());
    expect(reports).toHaveLength(JOB_SLOTS);
    expect(reports.map((r) => r.enrollmentId)).toEqual(ids.slice(0, JOB_SLOTS));
    for (const id of ids.slice(JOB_SLOTS)) {
      expect((await findEnrollment(client, id))!.next_due_at_ms).toBeLessThanOrEqual(NOW);
    }
  });

  it("counts runs already holding a lease against the slots", async () => {
    const held = await enroll({ user_id: "held", next_due_at_ms: NOW + 999_999 });
    await claimLease(client, held, { leaseId: "busy", untilMs: NOW + 60_000 }, NOW - 1);
    await enroll({ user_id: "a" });
    await enroll({ user_id: "b" });
    const reports = await dispatch({}, deps());
    expect(reports).toHaveLength(JOB_SLOTS - 1);
  });

  it("skips an enrollment that is not due, turned off or manual only", async () => {
    await enroll({ user_id: "future", next_due_at_ms: NOW + 1 });
    await enroll({ user_id: "manual", time_of_day: null, next_due_at_ms: null });
    expect(await dispatch({}, deps())).toEqual([]);
    expect(invokes).toEqual([]);
  });

  it.each<[string, InvokeResult, Partial<JobRow>]>([
    [
      "a non-2xx answer",
      { kind: "answered", statusCode: 500, body: JSON.stringify({ message: "Peloton said no" }) },
      { last_status: "failed", attention: "failed", failures: 1, last_message: "Peloton said no" },
    ],
    [
      "an answer without a message",
      { kind: "answered", statusCode: 404, body: "Not found" },
      { last_status: "failed", attention: "failed", last_message: "The app answered 404." },
    ],
    [
      "a function error",
      { kind: "function-error", message: "Task timed out" },
      {
        last_status: "failed",
        attention: "failed",
        last_message: "The app's function failed: Task timed out",
      },
    ],
    [
      "an invoke error",
      { kind: "invoke-error", message: "AccessDenied" },
      {
        last_status: "failed",
        attention: "failed",
        last_message: "The job could not start: AccessDenied",
      },
    ],
    [
      "a throttle, which is no failure and runs on the next tick",
      { kind: "throttled" },
      { last_status: "deferred", attention: null, failures: 0, next_due_at_ms: NOW },
    ],
  ])("records %s", async (_case, result, expected) => {
    const id = await enroll();
    answer = () => result;
    await dispatch({}, deps());
    expect(await findEnrollment(client, id)).toMatchObject({ lease_id: null, ...expected });
  });

  it("stops a signed-out user's enrollment and a user without a library", async () => {
    const id = await enroll();
    userCheck = { ok: false, reason: "refused" };
    await dispatch({}, deps());
    expect(await findEnrollment(client, id)).toMatchObject({
      attention: "signed-out",
      last_status: "stopped",
      next_due_at_ms: null,
      revoked_at_ms: null,
    });
    const other = await enroll({ user_id: "user-b" });
    userCheck = { ok: false, reason: "no-library" };
    await dispatch({}, deps());
    expect((await findEnrollment(client, other))!.attention).toBe("no-library");
    expect(invokes).toEqual([]);
  });

  it("defers a run while Cognito does not answer", async () => {
    const id = await enroll();
    userCheck = { ok: false, reason: "unavailable" };
    await dispatch({}, deps());
    expect(await findEnrollment(client, id)).toMatchObject({
      last_status: "deferred",
      next_due_at_ms: NOW,
      attention: null,
    });
    expect(invokes).toEqual([]);
  });

  it("stops with needs-consent when the app drops the job or widens its mode", async () => {
    const dropped = await enroll();
    await install([]);
    await dispatch({}, deps());
    expect(await findEnrollment(client, dropped)).toMatchObject({
      attention: "needs-consent",
      next_due_at_ms: null,
    });

    await install([TICK]);
    const narrow = await enroll({ user_id: "reader", mode: "read" });
    await dispatch({}, deps());
    expect((await findEnrollment(client, narrow))!.attention).toBe("needs-consent");
    expect(invokes).toEqual([]);
  });

  it("stops with needs-consent when the app has no cloud web app", async () => {
    const id = await enroll();
    await install([TICK], false);
    await dispatch({}, deps());
    expect((await findEnrollment(client, id))!.attention).toBe("needs-consent");
  });

  it("runs at the narrower mode when the app narrows the job", async () => {
    await install([{ ...TICK, mode: "read" }]);
    await enroll({ mode: "readwrite" });
    await dispatch({}, deps());
    const auth = (invokes[0]!.event.headers as Record<string, string>).authorization!;
    expect(verifyDelegationToken(auth.slice(7), publicKey, NOW)?.sk_mode).toBe("read");
  });
});

describe("a manual run", () => {
  it("runs an enrollment whose lease the data server claimed", async () => {
    const id = await enroll({ time_of_day: null, next_due_at_ms: null });
    await claimLease(client, id, { leaseId: "manual-1", untilMs: NOW + 100_000 }, NOW);
    const reports = await dispatch({ kind: "run", enrollmentId: id, leaseId: "manual-1" }, deps());
    expect(reports.map((r) => r.outcome)).toEqual(["ok"]);
    expect(JSON.parse(invokes[0]!.event.body as string)).toMatchObject({
      trigger: "manual",
      runId: "manual-1",
      scheduledFor: null,
    });
    expect(await findEnrollment(client, id)).toMatchObject({
      last_status: "ok",
      lease_id: null,
      next_due_at_ms: null,
    });
  });

  it("does nothing once the lease has passed to another run", async () => {
    const id = await enroll();
    await claimLease(client, id, { leaseId: "other", untilMs: NOW + 100_000 }, NOW);
    expect(await dispatch({ kind: "run", enrollmentId: id, leaseId: "manual-1" }, deps())).toEqual(
      [],
    );
    expect(invokes).toEqual([]);
    expect((await findEnrollment(client, id))!.lease_id).toBe("other");
  });
});
