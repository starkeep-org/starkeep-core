/**
 * Route-level tests for the ASYNC capability path (plan §3.8) — StartAsyncInvoke
 * start + GetAsyncInvoke poll. A purpose-built in-memory DatabaseClient backs the
 * capability tables AND the async-jobs table, so reserve → gate check → job
 * record → completing-poll commit + output-bytes append runs end to end. The
 * async Bedrock invoker, the by-reference content read, and the output S3 HEAD
 * are injected fakes — no AWS.
 */
import { describe, it, expect } from "vitest";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import {
  handleCapabilityInvokeAsyncStart,
  handleCapabilityInvokeAsyncStatus,
  type CapabilityAsyncStartDeps,
  type CapabilityAsyncStatusDeps,
  type ContentReadResult,
} from "../src/capability-handler.js";
import {
  buildAsyncModelInput,
  type BedrockAsyncInvoker,
  type BedrockAsyncStartRequest,
} from "../src/bedrock-client.js";

interface LedgerRow {
  invocation_id: string;
  app_id: string;
  provider: string;
  model: string;
  dimension: string;
  unit: string;
  quantity: number;
  status: string;
  ts: string;
}

interface JobRow {
  invocation_id: string;
  app_id: string;
  capability_name: string;
  provider: string;
  model: string;
  invocation_arn: string;
  output_bucket: string;
  output_key_prefix: string;
  status: string;
}

interface GateSeed {
  dimension: string;
  unit: string;
  scope_provider?: string | null;
  scope_model?: string | null;
  scope_app_id?: string | null;
  limit_value: number;
}

class InMemoryDb implements DatabaseClient {
  ledger: LedgerRow[] = [];
  jobs: JobRow[] = [];
  constructor(
    private grant: { models: string[]; reports: string[] } | null,
    private gates: GateSeed[] = [],
  ) {}

  async query(text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const v = values;
    if (text.includes('"capability_grants"')) {
      return {
        rows: this.grant
          ? [{ models_json: JSON.stringify(this.grant.models), reports_json: JSON.stringify(this.grant.reports) }]
          : [],
      };
    }
    if (text.includes('"capability_gates"')) {
      return {
        rows: this.gates.map((g, i) => ({
          id: `g${i}`,
          dimension: g.dimension,
          unit: g.unit,
          scope_provider: g.scope_provider ?? null,
          scope_model: g.scope_model ?? null,
          scope_app_id: g.scope_app_id ?? null,
          window_kind: "calendar",
          window_period: "month",
          window_seconds: null,
          limit_value: g.limit_value,
          on_exceed: "deny",
        })),
      };
    }
    if (text.includes('"capability_model_overrides"')) {
      return { rows: [] };
    }
    // ---- async jobs ----
    if (text.startsWith("insert into") && text.includes('"capability_async_jobs"')) {
      // columns: invocation_id, app_id, capability_name, provider, model,
      // invocation_arn, output_bucket, output_key_prefix, status
      this.jobs.push({
        invocation_id: String(v[0]),
        app_id: String(v[1]),
        capability_name: String(v[2]),
        provider: String(v[3]),
        model: String(v[4]),
        invocation_arn: String(v[5]),
        output_bucket: String(v[6]),
        output_key_prefix: String(v[7]),
        status: String(v[8]),
      });
      return { rows: [] };
    }
    if (text.startsWith("select") && text.includes('"capability_async_jobs"')) {
      const [inv, appId] = v as string[];
      const j = this.jobs.find((r) => r.invocation_id === inv && r.app_id === appId);
      return { rows: j ? [{ ...j }] : [] };
    }
    if (text.startsWith("update") && text.includes('"capability_async_jobs"')) {
      // set status = ? where invocation_id = ? and status = 'running'
      const [status, inv] = v as string[];
      for (const j of this.jobs) {
        if (j.invocation_id === inv && j.status === "running") j.status = status;
      }
      return { rows: [] };
    }
    // ---- ledger ----
    if (text.startsWith("insert into") && text.includes('"capability_ledger"')) {
      this.ledger.push({
        invocation_id: String(v[1]),
        app_id: String(v[2]),
        provider: String(v[4]),
        model: String(v[5]),
        dimension: String(v[6]),
        unit: String(v[7]),
        quantity: Number(v[8]),
        status: String(v[9]),
        ts: new Date().toISOString(),
      });
      return { rows: [] };
    }
    if (text.startsWith("select sum") && text.includes('"capability_ledger"')) {
      const [dimension, unit, s1, s2, _startIso, ...scope] = v as string[];
      const statuses = [s1, s2];
      const scopeCols: string[] = [];
      if (text.includes('"app_id" =')) scopeCols.push("app_id");
      if (text.includes('"provider" =')) scopeCols.push("provider");
      if (text.includes('"model" =')) scopeCols.push("model");
      const total = this.ledger
        .filter((r) => r.dimension === dimension && r.unit === unit && statuses.includes(r.status))
        .filter((r) => scopeCols.every((c, i) => (r as unknown as Record<string, unknown>)[c] === scope[i]))
        .reduce((sum, r) => sum + r.quantity, 0);
      return { rows: [{ total }] };
    }
    if (text.startsWith("update") && text.includes('"capability_ledger"')) {
      // commitReservation / release: set status = ? where invocation_id = ? and status = 'reserved'
      const [status, inv] = v as [string, string];
      for (const r of this.ledger) {
        if (r.invocation_id === inv && r.status === "reserved") r.status = status;
      }
      return { rows: [] };
    }
    if (text.startsWith("select count") && text.includes('"capability_ledger"')) {
      const [inv, dim, unit, status] = v as [string, string, string, string];
      const n = this.ledger.filter(
        (r) => r.invocation_id === inv && r.dimension === dim && r.unit === unit && r.status === status,
      ).length;
      return { rows: [{ n }] };
    }
    throw new Error(`InMemoryDb: unhandled SQL: ${text}`);
  }
  async end() {}
}

function makeAsyncInvoker(over: Partial<BedrockAsyncInvoker> = {}): BedrockAsyncInvoker {
  return {
    async startAsync() {
      return { invocationArn: "arn:aws:bedrock:us-east-1:111122223333:async-invoke/abc" };
    },
    async getAsyncStatus() {
      return { status: "InProgress" };
    },
    ...over,
  };
}

const target = (invocationId: string) => ({
  bucket: "stk-files-1",
  keyPrefix: `apps/photos/syncable/capability-async/${encodeURIComponent(invocationId)}`,
  s3Uri: `s3://stk-files-1/apps/photos/syncable/capability-async/${encodeURIComponent(invocationId)}/`,
});

function startDeps(
  db: InMemoryDb,
  over: Partial<CapabilityAsyncStartDeps> = {},
): CapabilityAsyncStartDeps {
  return {
    appId: "photos",
    capabilityName: "bedrock.invoke",
    body: { model: "amazon.nova-reel", prompt: "a cat surfing", generation: { durationSeconds: 6 } },
    capClient: db,
    assumeCapabilityCreds: async () => ({ accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" }),
    asyncInvoker: makeAsyncInvoker(),
    region: "us-east-1",
    accountId: "111122223333",
    resolveOutputTarget: target,
    timeZone: "UTC",
    ...over,
  };
}

function statusDeps(
  db: InMemoryDb,
  invocationId: string,
  over: Partial<CapabilityAsyncStatusDeps> = {},
): CapabilityAsyncStatusDeps {
  return {
    appId: "photos",
    capabilityName: "bedrock.invoke",
    invocationId,
    capClient: db,
    assumeCapabilityCreds: async () => ({ accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" }),
    asyncInvoker: makeAsyncInvoker(),
    region: "us-east-1",
    headOutput: async () => ({ keys: ["output.mp4"], totalBytes: 2_500_000 }),
    ...over,
  };
}

describe("async capability start (plan §3.8)", () => {
  it("reserves, starts the job, records it, and returns 202 with the output location", async () => {
    const db = new InMemoryDb({ models: ["amazon.nova-reel"], reports: [] });
    let capturedStart: BedrockAsyncStartRequest | undefined;
    let capturedScope: unknown;
    const res = await handleCapabilityInvokeAsyncStart(
      startDeps(db, {
        assumeCapabilityCreds: async (scope) => {
          capturedScope = scope;
          return { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" };
        },
        asyncInvoker: makeAsyncInvoker({
          async startAsync(req) {
            capturedStart = req;
            return { invocationArn: "arn:job:1" };
          },
        }),
      }),
    );
    expect(res.statusCode).toBe(202);
    const body = res.body as { invocationId: string; status: string; output: { keyPrefix: string } };
    expect(body.status).toBe("running");
    // Job recorded for later polling.
    expect(db.jobs).toHaveLength(1);
    expect(db.jobs[0].invocation_arn).toBe("arn:job:1");
    expect(db.jobs[0].status).toBe("running");
    // Reservation on the ledger: CDS-derived duration + derived cost, NO output tokens.
    const reserved = db.ledger.filter((r) => r.status === "reserved");
    expect(reserved.some((r) => r.dimension === "output" && r.unit === "duration_s" && r.quantity === 6)).toBe(true);
    expect(reserved.some((r) => r.dimension === "output" && r.unit === "tokens")).toBe(false);
    expect(reserved.some((r) => r.dimension === "cost" && r.unit === "usd" && r.quantity === 6 * 0.08)).toBe(true);
    // Start assume is scoped to the single output PREFIX + async verbs.
    expect(capturedScope).toMatchObject({
      bedrockAsync: true,
      s3PutKeyPrefixes: [{ bucket: "stk-files-1", keyPrefix: body.output.keyPrefix }],
    });
    // Output URI handed to Bedrock matches the resolved target.
    expect(capturedStart?.outputS3Uri).toContain(body.output.keyPrefix);
    expect(capturedStart?.outputBucketOwner).toBe("111122223333");
  });

  it("rejects a text-output model on the async route (delivered inline, not S3)", async () => {
    const db = new InMemoryDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] });
    const res = await handleCapabilityInvokeAsyncStart(
      startDeps(db, { body: { model: "anthropic.claude-haiku-4-5", prompt: "hi" } }),
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe("output_not_async");
  });

  it("returns not_granted (403) with no grant", async () => {
    const db = new InMemoryDb(null);
    const res = await handleCapabilityInvokeAsyncStart(startDeps(db));
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("not_granted");
  });

  it("denies (429) on a cost gate and releases the reservation without starting a job", async () => {
    const db = new InMemoryDb({ models: ["amazon.nova-reel"], reports: [] }, [
      { dimension: "cost", unit: "usd", scope_app_id: "photos", limit_value: 0 },
    ]);
    let started = false;
    const res = await handleCapabilityInvokeAsyncStart(
      startDeps(db, {
        asyncInvoker: makeAsyncInvoker({
          async startAsync() {
            started = true;
            return { invocationArn: "x" };
          },
        }),
      }),
    );
    expect(res.statusCode).toBe(429);
    expect(started).toBe(false);
    expect(db.jobs).toHaveLength(0);
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("releases the reservation and 502s when StartAsyncInvoke throws", async () => {
    const db = new InMemoryDb({ models: ["amazon.nova-reel"], reports: [] });
    const res = await handleCapabilityInvokeAsyncStart(
      startDeps(db, {
        asyncInvoker: makeAsyncInvoker({
          async startAsync() {
            throw new Error("nova exploded");
          },
        }),
      }),
    );
    expect(res.statusCode).toBe(502);
    expect(db.jobs).toHaveLength(0);
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });
});

const s3ImageContent = async (): Promise<ContentReadResult> => ({
  ok: true,
  content: {
    sizeBytes: 12_000_000,
    image: { format: "jpeg", s3Uri: "s3://stk-files-1/shared/image/ab/cd/pic.jpg", bucketOwner: "111122223333" },
    s3Key: { bucket: "stk-files-1", key: "shared/image/ab/cd/pic.jpg" },
  },
});

describe("async capability start — conditioning image (S3-location input)", () => {
  it("scopes the assume to BOTH the output prefix and the input key", async () => {
    const db = new InMemoryDb({ models: ["amazon.nova-reel"], reports: [] });
    let capturedScope: { s3Keys?: unknown[]; s3PutKeyPrefixes?: unknown[] } | undefined;
    const res = await handleCapabilityInvokeAsyncStart(
      startDeps(db, {
        body: {
          model: "amazon.nova-reel",
          prompt: "animate this",
          contentRef: { recordId: "rec_1" },
          generation: { durationSeconds: 6 },
        },
        readContent: s3ImageContent,
        assumeCapabilityCreds: async (scope) => {
          capturedScope = scope;
          return { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" };
        },
      }),
    );
    expect(res.statusCode).toBe(202);
    expect(capturedScope?.s3Keys).toEqual([{ bucket: "stk-files-1", key: "shared/image/ab/cd/pic.jpg" }]);
    expect(capturedScope?.s3PutKeyPrefixes).toHaveLength(1);
  });
});

describe("async capability status (plan §3.8)", () => {
  async function startOne(db: InMemoryDb): Promise<string> {
    const res = await handleCapabilityInvokeAsyncStart(startDeps(db));
    return (res.body as { invocationId: string }).invocationId;
  }

  it("returns running while the job is in progress (no ledger change)", async () => {
    const db = new InMemoryDb({ models: ["amazon.nova-reel"], reports: [] });
    const id = await startOne(db);
    const res = await handleCapabilityInvokeAsyncStatus(
      statusDeps(db, id, { asyncInvoker: makeAsyncInvoker({ async getAsyncStatus() { return { status: "InProgress" }; } }) }),
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { status: string }).status).toBe("running");
    // Still reserved, not committed.
    expect(db.ledger.some((r) => r.status === "reserved")).toBe(true);
    expect(db.ledger.some((r) => r.status === "committed")).toBe(false);
  });

  it("on completion commits the reservation, records output bytes, and returns the output keys", async () => {
    const db = new InMemoryDb({ models: ["amazon.nova-reel"], reports: [] });
    const id = await startOne(db);
    const res = await handleCapabilityInvokeAsyncStatus(
      statusDeps(db, id, {
        asyncInvoker: makeAsyncInvoker({ async getAsyncStatus() { return { status: "Completed" }; } }),
        headOutput: async () => ({ keys: ["output.mp4", "manifest.json"], totalBytes: 3_000_000 }),
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { status: string; output: { keys: string[]; totalBytes: number } };
    expect(body.status).toBe("completed");
    expect(body.output.keys).toEqual(["output.mp4", "manifest.json"]);
    expect(body.output.totalBytes).toBe(3_000_000);
    // Reservation committed; no reserved rows remain.
    expect(db.ledger.some((r) => r.status === "reserved")).toBe(false);
    // output:bytes recorded as a committed CDS measurement.
    expect(
      db.ledger.some((r) => r.status === "committed" && r.dimension === "output" && r.unit === "bytes" && r.quantity === 3_000_000),
    ).toBe(true);
    // Cost stays the CDS-derived reservation value.
    expect(
      db.ledger.some((r) => r.status === "committed" && r.dimension === "cost" && r.unit === "usd" && r.quantity === 6 * 0.08),
    ).toBe(true);
    // Job marked completed.
    expect(db.jobs[0].status).toBe("completed");
  });

  it("a second poll after completion replays idempotently without a double reconcile", async () => {
    const db = new InMemoryDb({ models: ["amazon.nova-reel"], reports: [] });
    const id = await startOne(db);
    const completed = makeAsyncInvoker({ async getAsyncStatus() { return { status: "Completed" }; } });
    await handleCapabilityInvokeAsyncStatus(statusDeps(db, id, { asyncInvoker: completed }));
    const outputBytesRows = () =>
      db.ledger.filter((r) => r.dimension === "output" && r.unit === "bytes").length;
    const afterFirst = outputBytesRows();
    // A second poll: job is terminal, so it must NOT append another output:bytes row.
    const res2 = await handleCapabilityInvokeAsyncStatus(statusDeps(db, id, { asyncInvoker: completed }));
    expect((res2.body as { status: string }).status).toBe("completed");
    expect(outputBytesRows()).toBe(afterFirst);
  });

  it("on failure releases the reservation and reports failed", async () => {
    const db = new InMemoryDb({ models: ["amazon.nova-reel"], reports: [] });
    const id = await startOne(db);
    const res = await handleCapabilityInvokeAsyncStatus(
      statusDeps(db, id, {
        asyncInvoker: makeAsyncInvoker({ async getAsyncStatus() { return { status: "Failed", failureMessage: "content filtered" }; } }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { status: string }).status).toBe("failed");
    // Reservation released → drops out of the gate SUM.
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
    expect(db.jobs[0].status).toBe("failed");
  });

  it("404s an unknown invocation, and won't reveal another app's job", async () => {
    const db = new InMemoryDb({ models: ["amazon.nova-reel"], reports: [] });
    const id = await startOne(db);
    // Same id but a different app must not resolve the job — the app_id-scoped
    // job lookup returns 404 (never leaks another app's job) even though this
    // fake grant is shared across apps.
    const res = await handleCapabilityInvokeAsyncStatus(statusDeps(db, id, { appId: "notes" }));
    expect(res.statusCode).toBe(404);
    const res2 = await handleCapabilityInvokeAsyncStatus(statusDeps(db, "nope"));
    expect(res2.statusCode).toBe(404);
  });

  it("a transient poll error leaves the job running (no state change)", async () => {
    const db = new InMemoryDb({ models: ["amazon.nova-reel"], reports: [] });
    const id = await startOne(db);
    const res = await handleCapabilityInvokeAsyncStatus(
      statusDeps(db, id, {
        asyncInvoker: makeAsyncInvoker({ async getAsyncStatus() { throw new Error("throttled"); } }),
      }),
    );
    expect(res.statusCode).toBe(502);
    expect(db.jobs[0].status).toBe("running");
    expect(db.ledger.some((r) => r.status === "reserved")).toBe(true);
  });
});

describe("buildAsyncModelInput (Nova Reel body)", () => {
  it("builds a TEXT_VIDEO body with the requested duration", () => {
    const body = buildAsyncModelInput({
      target: "amazon.nova-reel",
      region: "us-east-1",
      provider: "amazon",
      prompt: "a cat surfing",
      generation: { durationSeconds: 6, fps: 24, dimension: "1280x720" },
      outputS3Uri: "s3://b/k/",
      credentials: { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" },
    }) as { taskType: string; textToVideoParams: { text: string }; videoGenerationConfig: { durationSeconds: number } };
    expect(body.taskType).toBe("TEXT_VIDEO");
    expect(body.textToVideoParams.text).toBe("a cat surfing");
    expect(body.videoGenerationConfig.durationSeconds).toBe(6);
  });

  it("throws for a provider without an async adapter", () => {
    expect(() =>
      buildAsyncModelInput({
        target: "anthropic.x",
        region: "us-east-1",
        provider: "anthropic",
        prompt: "x",
        outputS3Uri: "s3://b/k/",
        credentials: { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" },
      }),
    ).toThrow(/not supported/);
  });
});
