/**
 * Route-level tests for the capability broker handler. The shared
 * {@link InMemoryCapabilityDb} simulates the capability tables and, crucially,
 * maintains real ledger state — including row timestamps and the `ts >=` window
 * predicate — so reserve → scoped-SUM gate check → reconcile is exercised end to
 * end (including genuine breaches, window rollovers, and interleaved requests).
 * The Bedrock invoker and the content read are injected fakes — no AWS.
 */
import { describe, it, expect } from "vitest";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import {
  handleCapabilityInvoke,
  handleCapabilityInvokeStream,
  type CapabilityHandlerDeps,
  type ContentReadResult,
  type SyncImageOutput,
} from "../src/capability-handler.js";
import {
  buildImageModelInput,
  type BedrockInvoker,
  type BedrockImageInvoker,
  type BedrockImageGenRequest,
} from "../src/bedrock-client.js";

import { InMemoryCapabilityDb, type GateSeed } from "./in-memory-capability-db.js";

/** Positional constructor kept for readability at the (many) call sites below. */
function makeDb(
  grant: { models: string[]; reports: string[] } | null,
  gates: GateSeed[] = [],
  overrides: Record<string, unknown>[] = [],
): InMemoryCapabilityDb {
  return new InMemoryCapabilityDb({ grant, gates, overrides });
}

const fakeInvoker: BedrockInvoker = {
  async converse() {
    return { text: "a cat on a mat", inputTokens: 1200, outputTokens: 8 };
  },
  // eslint-disable-next-line require-yield
  async *converseStream() {
    throw new Error("not used");
  },
};

const imageContent = async (): Promise<ContentReadResult> => ({
  ok: true,
  content: { sizeBytes: 2048, image: { format: "jpeg", bytes: new Uint8Array([1, 2, 3]) } },
});

/** S3-location content: no inline bytes, an s3Uri image + the s3Key the broker
 * must scope the capability assume's session policy to (plan §3.4). */
const s3LocationContent = async (): Promise<ContentReadResult> => ({
  ok: true,
  content: {
    sizeBytes: 12_000_000,
    image: { format: "jpeg", s3Uri: "s3://stk-files-1/shared/image/ab/cd/pic.jpg", bucketOwner: "111122223333" },
    s3Key: { bucket: "stk-files-1", key: "shared/image/ab/cd/pic.jpg" },
  },
});

function baseDeps(
  db: InMemoryCapabilityDb,
  over: Partial<CapabilityHandlerDeps> = {},
): CapabilityHandlerDeps {
  return {
    appId: "photos",
    capabilityName: "bedrock.invoke",
    body: {
      model: "anthropic.claude-haiku-4-5",
      prompt: "Describe this image.",
      contentRef: { recordId: "rec_1" },
      maxTokens: 100,
    },
    capClient: db,
    readContent: imageContent,
    assumeCapabilityCreds: async () => ({ accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" }),
    invoker: fakeInvoker,
    region: "us-east-1",
    timeZone: "UTC",
    ...over,
  };
}

describe("capability handler", () => {
  it("invokes and returns text + usage + reconciled cost with no gates", async () => {
    const db = makeDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    const res = await handleCapabilityInvoke(baseDeps(db));
    expect(res.statusCode).toBe(200);
    const body = res.body as { text: string; usage: { inputTokens: number }; estCostMicros: number };
    expect(body.text).toBe("a cat on a mat");
    expect(body.usage.inputTokens).toBe(1200);
    // ledger reconciled: reserved rows promoted to committed with actuals.
    const committed = db.ledger.filter((r) => r.status === "committed");
    expect(committed.some((r) => r.dimension === "input" && r.unit === "tokens" && r.quantity === 1200)).toBe(true);
    expect(committed.some((r) => r.dimension === "output" && r.unit === "tokens" && r.quantity === 8)).toBe(true);
    // cost re-derived from actual tokens (1200*$1/MTok + 8*$5/MTok)
    expect(body.estCostMicros).toBe(1200 * 1 + 8 * 5); // micros: $1/MTok in, $5/MTok out
  });

  it("returns not_granted (403) when the app has no capability grant", async () => {
    const db = makeDb(null, []);
    const res = await handleCapabilityInvoke(baseDeps(db));
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("not_granted");
  });

  it("returns model_not_granted (403) for a model outside the approved set", async () => {
    const db = makeDb({ models: ["anthropic.claude-opus-4-8"], reports: [] }, []);
    const res = await handleCapabilityInvoke(baseDeps(db));
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("model_not_granted");
  });

  it("propagates a content read failure", async () => {
    const db = makeDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    const res = await handleCapabilityInvoke(
      baseDeps(db, { readContent: async () => ({ ok: false, status: 403, message: "content_forbidden" }) }),
    );
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("content_forbidden");
  });

  it("denies (429) when a request cost gate is already exceeded, and releases the reservation", async () => {
    // A $0-limit per-app cost gate: any reservation cost > 0 breaches.
    const db = makeDb(
      { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      [{ dimension: "cost", unit: "usd_micros", scope_app_id: "photos", limit_value: 0 }],
    );
    const res = await handleCapabilityInvoke(baseDeps(db));
    expect(res.statusCode).toBe(429);
    expect((res.body as { error: string }).error).toBe("gate_exceeded");
    // Reservation released → no reserved/committed rows remain in the SUM.
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("enforces a request-count gate across successive calls", async () => {
    const db = makeDb(
      { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      [{ dimension: "requests", unit: "all", limit_value: 1 }],
    );
    const first = await handleCapabilityInvoke(baseDeps(db));
    expect(first.statusCode).toBe(200);
    const second = await handleCapabilityInvoke(baseDeps(db));
    expect(second.statusCode).toBe(429);
  });

  it("FAILS CLOSED (403) when a gate targets an undeclared non-generic dimension", async () => {
    const db = makeDb(
      { models: ["anthropic.claude-haiku-4-5"], reports: [] }, // no reports declared
      [{ dimension: "input", unit: "pixels", scope_app_id: "photos", limit_value: 1000 }],
    );
    const res = await handleCapabilityInvoke(baseDeps(db));
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("undeclared_dimension");
    // Never reserved (fail-closed happens before the ledger write).
    expect(db.ledger).toHaveLength(0);
  });

  it("allows an app-reported dimension gate once declared", async () => {
    const db = makeDb(
      { models: ["anthropic.claude-haiku-4-5"], reports: ["input:pixels"] },
      [{ dimension: "input", unit: "pixels", scope_app_id: "photos", limit_value: 1000 }],
    );
    const res = await handleCapabilityInvoke(
      baseDeps(db, {
        body: {
          model: "anthropic.claude-haiku-4-5",
          prompt: "caption",
          contentRef: { recordId: "rec_1" },
          maxTokens: 50,
          reports: { "input:pixels": 12 },
        },
      }),
    );
    expect(res.statusCode).toBe(200);
  });

  it("releases the reservation and 502s when the invoker throws", async () => {
    const db = makeDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    const res = await handleCapabilityInvoke(
      baseDeps(db, {
        invoker: {
          async converse() {
            throw new Error("bedrock exploded");
          },
          async *converseStream() {},
        },
      }),
    );
    expect(res.statusCode).toBe(502);
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("404s an unknown capability name", async () => {
    const db = makeDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    const res = await handleCapabilityInvoke(baseDeps(db, { capabilityName: "bedrock.knowledgeBase" }));
    expect(res.statusCode).toBe(404);
  });

  it("rejects a non-text (video) model on the inline route — must use async (§3.8)", async () => {
    const db = makeDb({ models: ["amazon.nova-reel-v1:1"], reports: [] }, []);
    const res = await handleCapabilityInvoke(
      baseDeps(db, { body: { model: "amazon.nova-reel-v1:1", prompt: "a cat surfing" } }),
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe("output_requires_async");
    // Guard fires before any reservation is written.
    expect(db.ledger).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gate WINDOWS through the handler (the ledger honours `ts >=` and timeZone)
// ---------------------------------------------------------------------------

describe("capability handler — gate windows", () => {
  const T0 = Date.UTC(2026, 6, 23, 12, 0);

  /** Deps + a ledger that share one mutable clock. */
  function clocked(gates: GateSeed[], startMs = T0) {
    let now = startMs;
    const db = new InMemoryCapabilityDb({
      grant: { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      gates,
      now: () => now,
    });
    return {
      db,
      advance: (ms: number) => {
        now += ms;
      },
      deps: (over: Partial<CapabilityHandlerDeps> = {}) =>
        baseDeps(db, { nowMs: () => now, ...over }),
    };
  }

  it("a burst gate denies inside the window and allows once the window slides past", async () => {
    const { db, advance, deps } = clocked([
      { dimension: "requests", unit: "all", limit_value: 1, window_kind: "burst", window_period: null, window_seconds: 60 },
    ]);
    expect((await handleCapabilityInvoke(deps())).statusCode).toBe(200);
    // Second request 10s later is still inside the 60s burst window.
    advance(10_000);
    expect((await handleCapabilityInvoke(deps())).statusCode).toBe(429);
    // 61s after the first, the first request's rows have aged out of the window.
    advance(51_000);
    expect((await handleCapabilityInvoke(deps())).statusCode).toBe(200);
    expect(
      db.ledger.filter((r) => r.status === "committed" && r.dimension === "requests" && r.unit === "all"),
    ).toHaveLength(2);
  });

  it("a calendar-month gate resets at the month rollover", async () => {
    // $20/month, and a prior-month spend that has already consumed it.
    const { db, advance, deps } = clocked(
      [{ dimension: "cost", unit: "usd_micros", scope_app_id: "photos", limit_value: 20_000_000 }],
      Date.UTC(2026, 5, 15), // June 15
    );
    db.seedLedger({ dimension: "cost", unit: "usd_micros", quantity: 20_000_000, app_id: "photos" });
    // Still June: the budget is spent.
    expect((await handleCapabilityInvoke(deps())).statusCode).toBe(429);
    // July 1: June's spend is outside the window, so the app can invoke again.
    advance(Date.UTC(2026, 6, 1) - Date.UTC(2026, 5, 15));
    expect((await handleCapabilityInvoke(deps())).statusCode).toBe(200);
  });

  it("aligns the month window to STARKEEP_CAPABILITY_TZ, not UTC", async () => {
    // The spend lands 2026-06-30T23:00Z — June everywhere. `now` is
    // 2026-07-01T03:00Z: July in UTC, but still June 30 in Los Angeles.
    const gates: GateSeed[] = [{ dimension: "cost", unit: "usd_micros", scope_app_id: "photos", limit_value: 20_000_000 }];
    const spentAt = Date.UTC(2026, 5, 30, 23, 0);
    const now = Date.UTC(2026, 6, 1, 3, 0);

    const utc = new InMemoryCapabilityDb({
      grant: { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      gates,
      now: () => spentAt,
    });
    utc.seedLedger({ dimension: "cost", unit: "usd_micros", quantity: 20_000_000, app_id: "photos" });
    // UTC has already rolled into July → last month's spend no longer counts.
    expect(
      (await handleCapabilityInvoke(baseDeps(utc, { nowMs: () => now, timeZone: "UTC" }))).statusCode,
    ).toBe(200);

    const la = new InMemoryCapabilityDb({
      grant: { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      gates,
      now: () => spentAt,
    });
    la.seedLedger({ dimension: "cost", unit: "usd_micros", quantity: 20_000_000, app_id: "photos" });
    // Los Angeles is still in June → the budget is still spent.
    expect(
      (await handleCapabilityInvoke(baseDeps(la, { nowMs: () => now, timeZone: "America/Los_Angeles" })))
        .statusCode,
    ).toBe(429);
  });

  it("only counts spend inside the window, so an old row never blocks a new month", async () => {
    const { db, deps } = clocked([
      { dimension: "cost", unit: "usd_micros", scope_app_id: "photos", limit_value: 1_000 },
    ]);
    // A large spend from the previous month.
    db.now = () => Date.UTC(2026, 5, 1);
    db.seedLedger({ dimension: "cost", unit: "usd_micros", quantity: 1_000_000_000, app_id: "photos" });
    db.now = () => T0;
    // The tiny in-window budget is what decides — and this request breaches it.
    const res = await handleCapabilityInvoke(deps());
    expect(res.statusCode).toBe(429);
    const breaches = (res.body as { breaches: { current: number }[] }).breaches;
    // `current` reflects only this month's reservation, not last month's $1000
    // (1e9 micros) — so it stays under a dollar rather than dwarfing the limit.
    expect(breaches[0]!.current).toBeLessThan(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// Reserve-on-ledger concurrency (plan §3.5) — the design's central claim
// ---------------------------------------------------------------------------

/**
 * Forces the interleaving the reserve-on-ledger scheme exists to survive:
 * every request reserves BEFORE any request sums, so each SUM sees the other's
 * in-flight reservation. Without reservations (committed-only accounting) both
 * requests would read a zero window and both would be allowed.
 */
class HoldSumsUntilAllReserved implements DatabaseClient {
  private reserved = 0;
  private release!: () => void;
  private readonly gateOpen: Promise<void>;
  constructor(
    private readonly inner: InMemoryCapabilityDb,
    private readonly expectedReservers: number,
  ) {
    this.gateOpen = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  async query(text: string, values: unknown[] = []) {
    if (text.startsWith("insert into") && text.includes('"capability_ledger"')) {
      const res = await this.inner.query(text, values);
      // Count each invocation's reservation once (its first inserted row).
      if (String(values[9]) === "reserved" && this.isFirstRowOf(String(values[1]))) {
        if (++this.reserved >= this.expectedReservers) this.release();
      }
      return res;
    }
    if (text.startsWith("select sum")) await this.gateOpen;
    return this.inner.query(text, values);
  }
  private isFirstRowOf(invocationId: string): boolean {
    return this.inner.ledger.filter((r) => r.invocation_id === invocationId).length === 1;
  }
  async end() {}
}

describe("capability handler — reserve-on-ledger concurrency (plan §3.5)", () => {
  it("two interleaved requests cannot both pass a limit-1 request gate", async () => {
    const inner = new InMemoryCapabilityDb({
      grant: { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      gates: [{ dimension: "requests", unit: "all", scope_app_id: "photos", limit_value: 1 }],
    });
    const db = new HoldSumsUntilAllReserved(inner, 2);
    const [a, b] = await Promise.all([
      handleCapabilityInvoke(baseDeps(inner, { capClient: db })),
      handleCapabilityInvoke(baseDeps(inner, { capClient: db })),
    ]);
    // Both saw both reservations (2 > 1), so both are denied — the safe,
    // over-counting direction. What must NEVER happen is both being allowed.
    expect([a.statusCode, b.statusCode].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    expect(a.statusCode).toBe(429);
    expect(b.statusCode).toBe(429);
    // Denied reservations are released, so the window is left clean.
    expect(inner.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("interleaved requests that together fit under the limit both pass", async () => {
    const inner = new InMemoryCapabilityDb({
      grant: { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      gates: [{ dimension: "requests", unit: "all", scope_app_id: "photos", limit_value: 2 }],
    });
    const db = new HoldSumsUntilAllReserved(inner, 2);
    const [a, b] = await Promise.all([
      handleCapabilityInvoke(baseDeps(inner, { capClient: db })),
      handleCapabilityInvoke(baseDeps(inner, { capClient: db })),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });

  it("bounds concurrent overage on a cost gate: a burst of 5 never all pass", async () => {
    const inner = new InMemoryCapabilityDb({
      grant: { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      // Worst-case reservation for maxTokens=100 is ~$0.0005; a $0.001 cap
      // affords two of them, no more.
      gates: [{ dimension: "cost", unit: "usd_micros", scope_app_id: "photos", limit_value: 1_000 }],
    });
    const db = new HoldSumsUntilAllReserved(inner, 5);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => handleCapabilityInvoke(baseDeps(inner, { capClient: db }))),
    );
    const allowed = results.filter((r) => r.statusCode === 200);
    expect(allowed.length).toBeLessThan(5);
    // Committed spend after the burst stays within the cap.
    const spent = inner.ledger
      .filter((r) => r.dimension === "cost" && r.status === "committed")
      .reduce((sum, r) => sum + r.quantity, 0);
    expect(spent).toBeLessThanOrEqual(0.001);
  });

  it("a released reservation frees the window for the next request", async () => {
    const db = makeDb(
      { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      [{ dimension: "requests", unit: "all", scope_app_id: "photos", limit_value: 1 }],
    );
    // The first request fails at Bedrock, so its reservation is released…
    const failed = await handleCapabilityInvoke(
      baseDeps(db, {
        invoker: {
          async converse() {
            throw new Error("bedrock exploded");
          },
          // eslint-disable-next-line require-yield
          async *converseStream() {
            throw new Error("not used");
          },
        },
      }),
    );
    expect(failed.statusCode).toBe(502);
    // …and does not consume the app's single-request budget.
    expect((await handleCapabilityInvoke(baseDeps(db))).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Unconditional cost ceilings + hostile-app input filtering
// ---------------------------------------------------------------------------

describe("capability handler — maxTokens clamping (unconditional ceiling)", () => {
  /** The reserved output-token row is the clamped ceiling. */
  async function reservedOutputTokens(maxTokens: number | undefined): Promise<number> {
    const db = makeDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    let seen = 0;
    await handleCapabilityInvoke(
      baseDeps(db, {
        body: { model: "anthropic.claude-haiku-4-5", prompt: "hi", ...(maxTokens === undefined ? {} : { maxTokens }) },
        invoker: {
          async converse(req) {
            seen = req.maxTokens;
            return { text: "ok", inputTokens: 1, outputTokens: 1 };
          },
          // eslint-disable-next-line require-yield
          async *converseStream() {
            throw new Error("not used");
          },
        },
      }),
    );
    return seen;
  }

  it("caps an absurd maxTokens at the hard ceiling even with no gates configured", async () => {
    expect(await reservedOutputTokens(10_000_000)).toBe(8192);
    expect(await reservedOutputTokens(8193)).toBe(8192);
  });

  it("floors maxTokens at 1 (zero/negative can't disable the output reservation)", async () => {
    expect(await reservedOutputTokens(0)).toBe(1);
    expect(await reservedOutputTokens(-5)).toBe(1);
  });

  it("defaults to 1024 when the app omits maxTokens", async () => {
    expect(await reservedOutputTokens(undefined)).toBe(1024);
  });

  it("passes a within-range value through untouched", async () => {
    expect(await reservedOutputTokens(512)).toBe(512);
  });

  it("reserves the clamped ceiling on the ledger, not the requested value", async () => {
    const db = makeDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    await handleCapabilityInvoke(
      baseDeps(db, {
        body: { model: "anthropic.claude-haiku-4-5", prompt: "hi", maxTokens: 1e9 },
      }),
    );
    // Every ledger row that ever existed for the invocation was written at the
    // clamp; the reconcile then trues it down to the actual 8 output tokens.
    expect(db.ledger.some((r) => r.quantity === 1e9)).toBe(false);
  });
});

describe("capability handler — appReports filtering (hostile-app input path)", () => {
  /** Run with the given `reports` and return the reserved app-reported rows. */
  async function reservedReports(
    reports: Record<string, unknown>,
    declared: string[] = ["input:pixels"],
  ) {
    const db = makeDb({ models: ["anthropic.claude-haiku-4-5"], reports: declared }, []);
    await handleCapabilityInvoke(
      baseDeps(db, {
        body: {
          model: "anthropic.claude-haiku-4-5",
          prompt: "caption",
          maxTokens: 50,
          reports: reports as Record<string, number>,
        },
      }),
    );
    return db.ledger.filter((r) => r.unit === "pixels" || r.unit === "count" || r.unit === "pages");
  }

  it("records a declared, non-generic, finite value", async () => {
    const rows = await reservedReports({ "input:pixels": 12 });
    expect(rows.map((r) => [r.dimension, r.unit, r.quantity])).toContainEqual(["input", "pixels", 12]);
  });

  it("ignores an UNDECLARED key even when it is otherwise valid", async () => {
    expect(await reservedReports({ "input:pages": 5 }, ["input:pixels"])).toHaveLength(0);
  });

  it("ignores a GENERIC key an app may not self-report", async () => {
    const db = makeDb({ models: ["anthropic.claude-haiku-4-5"], reports: ["input:bytes"] }, []);
    await handleCapabilityInvoke(
      baseDeps(db, {
        body: {
          model: "anthropic.claude-haiku-4-5",
          prompt: "caption",
          maxTokens: 50,
          // input:bytes is CDS-measured; the app cannot substitute its own value.
          reports: { "input:bytes": 1 },
        },
      }),
    );
    expect(db.ledger.filter((r) => r.dimension === "input" && r.unit === "bytes")).toHaveLength(0);
  });

  it("drops NaN / Infinity / non-numeric values", async () => {
    expect(await reservedReports({ "input:pixels": NaN })).toHaveLength(0);
    expect(await reservedReports({ "input:pixels": Infinity })).toHaveLength(0);
    expect(await reservedReports({ "input:pixels": -Infinity })).toHaveLength(0);
    expect(await reservedReports({ "input:pixels": "12" })).toHaveLength(0);
    expect(await reservedReports({ "input:pixels": null })).toHaveLength(0);
  });

  it("ignores a malformed key with no dimension:unit split", async () => {
    expect(await reservedReports({ megapixels: 3 })).toHaveLength(0);
    expect(await reservedReports({ "": 3 })).toHaveLength(0);
  });

  it("keeps the valid entries when a hostile app mixes in junk", async () => {
    const rows = await reservedReports({
      "input:pixels": 7,
      "input:bytes": 999_999,
      "cost:usd_micros": -1000,
      nonsense: 1,
    });
    expect(rows.map((r) => r.quantity)).toEqual([7]);
  });

  it("an undeclared report cannot dodge a declared gate's fail-closed check", async () => {
    // The gate targets input:pixels but the app declared nothing → deny,
    // regardless of what the app tried to report.
    const db = makeDb(
      { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      [{ dimension: "input", unit: "pixels", limit_value: 1000 }],
    );
    const res = await handleCapabilityInvoke(
      baseDeps(db, {
        body: {
          model: "anthropic.claude-haiku-4-5",
          prompt: "caption",
          maxTokens: 50,
          reports: { "input:pixels": 0 },
        },
      }),
    );
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("undeclared_dimension");
  });
});

describe("capability handler — S3-location delivery (plan §3.4)", () => {
  it("passes NO session scope on the inline path", async () => {
    const db = makeDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    let capturedScope: unknown = "unset";
    const res = await handleCapabilityInvoke(
      baseDeps(db, {
        readContent: imageContent,
        assumeCapabilityCreds: async (scope) => {
          capturedScope = scope;
          return { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" };
        },
      }),
    );
    expect(res.statusCode).toBe(200);
    // Inline: the capability role is assumed with no session policy (cacheable).
    expect(capturedScope).toBeUndefined();
  });

  it("scopes the capability assume to exactly the referenced S3 key, and delivers by s3Uri", async () => {
    const db = makeDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    let capturedScope: { s3Keys?: { bucket: string; key: string }[] } | undefined;
    let capturedImages: unknown;
    const spyInvoker: BedrockInvoker = {
      async converse(req) {
        capturedImages = req.images;
        return { text: "ok", inputTokens: 10, outputTokens: 2 };
      },
      // eslint-disable-next-line require-yield
      async *converseStream() {
        throw new Error("not used");
      },
    };
    const res = await handleCapabilityInvoke(
      baseDeps(db, {
        readContent: s3LocationContent,
        invoker: spyInvoker,
        assumeCapabilityCreds: async (scope) => {
          capturedScope = scope;
          return { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" };
        },
      }),
    );
    expect(res.statusCode).toBe(200);
    // The broker must fasten the single-key belt on the S3-location assume.
    expect(capturedScope?.s3Keys).toEqual([
      { bucket: "stk-files-1", key: "shared/image/ab/cd/pic.jpg" },
    ]);
    // Bedrock receives the image by S3 URI, not inline bytes.
    expect(capturedImages).toEqual([
      { format: "jpeg", s3Uri: "s3://stk-files-1/shared/image/ab/cd/pic.jpg", bucketOwner: "111122223333" },
    ]);
  });

  it("scopes the session on the streaming S3-location path too", async () => {
    const db = makeDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    let capturedScope: { s3Keys?: { bucket: string; key: string }[] } | undefined;
    const result = await handleCapabilityInvokeStream(
      baseDeps(db, {
        readContent: s3LocationContent,
        invoker: streamInvoker,
        assumeCapabilityCreds: async (scope) => {
          capturedScope = scope;
          return { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" };
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open stream");
    // Drain the stream so the invoke (and thus the assume) actually runs.
    for await (const _evt of result.stream) void _evt;
    expect(capturedScope?.s3Keys).toEqual([
      { bucket: "stk-files-1", key: "shared/image/ab/cd/pic.jpg" },
    ]);
  });
});

const streamInvoker: BedrockInvoker = {
  async converse() {
    throw new Error("not used");
  },
  async *converseStream() {
    yield { type: "text", text: "a cat " };
    yield { type: "text", text: "on a mat" };
    yield { type: "done", inputTokens: 1200, outputTokens: 8 };
  },
};

describe("capability handler — streaming", () => {
  it("yields text chunks then a done event and reconciles the ledger to actuals", async () => {
    const db = makeDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    const result = await handleCapabilityInvokeStream(baseDeps(db, { invoker: streamInvoker }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open stream");

    const events = [];
    for await (const evt of result.stream) events.push(evt);
    const text = events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : "")).join("");
    expect(text).toBe("a cat on a mat");
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.usage.outputTokens).toBe(8);
      // cost re-derived from actual tokens (1200*$1/MTok + 8*$5/MTok)
      expect(done.estCostMicros).toBe(1200 * 1 + 8 * 5);
    }
    // Reserved rows promoted to committed actuals on stream completion.
    const committed = db.ledger.filter((r) => r.status === "committed");
    expect(committed.some((r) => r.dimension === "output" && r.unit === "tokens" && r.quantity === 8)).toBe(true);
  });

  it("rejects pre-stream (not_granted 403) without opening a stream", async () => {
    const db = makeDb(null, []);
    const result = await handleCapabilityInvokeStream(baseDeps(db, { invoker: streamInvoker }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.statusCode).toBe(403);
  });

  it("rejects pre-stream on a gate breach (429) and releases the reservation", async () => {
    // A tiny output-token gate the worst-case reservation (maxTokens) breaches.
    const db = makeDb(
      { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      [{ dimension: "output", unit: "tokens", limit_value: 1 }],
    );
    const result = await handleCapabilityInvokeStream(baseDeps(db, { invoker: streamInvoker }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.statusCode).toBe(429);
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("releases the reservation and emits an error event when the stream throws", async () => {
    const db = makeDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    const result = await handleCapabilityInvokeStream(
      baseDeps(db, {
        invoker: {
          async converse() {
            throw new Error("not used");
          },
          // eslint-disable-next-line require-yield
          async *converseStream() {
            throw new Error("bedrock stream exploded");
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open stream");
    const events = [];
    for await (const evt of result.stream) events.push(evt);
    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sync-s3 (image) output — Nova Canvas, plan §3.8
// ---------------------------------------------------------------------------

const IMAGE_MODEL = "amazon.nova-canvas-v1:0";

/** A fake sync image generator returning fixed PNG bytes, capturing the request. */
function fakeImageInvoker(
  onReq?: (r: BedrockImageGenRequest) => void,
  images: Uint8Array[] = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])],
): BedrockImageInvoker {
  return {
    async generateImage(req) {
      onReq?.(req);
      return { images, format: "png" };
    },
  };
}

/** Deps for a prompt-only image-generation request (no contentRef). Captures
 * what the CDS wrote via writeSyncOutput. */
function imageDeps(
  db: InMemoryCapabilityDb,
  written: { calls: { invocationId: string; images: Uint8Array[]; contentType: string }[] },
  over: Partial<CapabilityHandlerDeps> = {},
): CapabilityHandlerDeps {
  return {
    appId: "photos",
    capabilityName: "bedrock.invoke",
    body: { model: IMAGE_MODEL, prompt: "a watercolor cat" },
    capClient: db,
    // Prompt-only generation: no contentRef, so the reader must never be
    // consulted. Fail loudly rather than silently returning empty content.
    readContent: async () => {
      throw new Error("readContent must not be called on a prompt-only image request");
    },
    assumeCapabilityCreds: async () => ({ accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" }),
    invoker: fakeInvoker,
    imageInvoker: fakeImageInvoker(),
    writeSyncOutput: async (invocationId, images, contentType): Promise<SyncImageOutput> => {
      written.calls.push({ invocationId, images, contentType });
      const total = images.reduce((n, im) => n + im.byteLength, 0);
      return {
        bucket: "stk-files-1",
        keyPrefix: `apps/photos/syncable/capability-image/${invocationId}`,
        keys: images.map((_, i) => `apps/photos/syncable/capability-image/${invocationId}/image-${i}.png`),
        totalBytes: total,
      };
    },
    region: "us-east-1",
    timeZone: "UTC",
    ...over,
  };
}

describe("capability handler — sync-s3 image output (plan §3.8)", () => {
  it("generates, writes the bytes under the app role, and returns the output key(s) + derived cost", async () => {
    const db = makeDb({ models: [IMAGE_MODEL], reports: [] }, []);
    const written = { calls: [] as { invocationId: string; images: Uint8Array[]; contentType: string }[] };
    const res = await handleCapabilityInvoke(imageDeps(db, written));

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      model: string;
      output: { bucket: string; keyPrefix: string; keys: string[]; totalBytes: number };
      usage: { inputTokens: number; outputTokens: number };
      estCostMicros: number;
      invocationId: string;
    };
    // The CDS wrote exactly one image to the app's syncable area (not inlined).
    expect(written.calls).toHaveLength(1);
    expect(written.calls[0]!.contentType).toBe("image/png");
    expect(body.output.keys).toHaveLength(1);
    expect(body.output.keys[0]).toContain("apps/photos/syncable/capability-image/");
    // No tokens for image gen; cost is CDS-derived per image (requests:image $0.04).
    expect(body.usage.outputTokens).toBe(0);
    expect(body.estCostMicros).toBe(40_000); // $0.04/image

    // Ledger: a committed cost row equal to the per-image price, a committed
    // requests:image, and a committed output:bytes measured from the write.
    const committed = db.ledger.filter((r) => r.status === "committed");
    const cost = committed.find((r) => r.dimension === "cost" && r.unit === "usd_micros");
    expect(cost?.quantity).toBe(40_000);
    expect(committed.some((r) => r.dimension === "requests" && r.unit === "image")).toBe(true);
    const outBytes = committed.find((r) => r.dimension === "output" && r.unit === "bytes");
    expect(outBytes?.quantity).toBe(written.calls[0]!.images[0]!.byteLength);
    // No reservation left dangling.
    expect(db.ledger.some((r) => r.status === "reserved")).toBe(false);
  });

  it("passes the prompt + generation params to the image invoker", async () => {
    const db = makeDb({ models: [IMAGE_MODEL], reports: [] }, []);
    let captured: BedrockImageGenRequest | undefined;
    const written = { calls: [] as { invocationId: string; images: Uint8Array[]; contentType: string }[] };
    const res = await handleCapabilityInvoke(
      imageDeps(db, written, {
        body: { model: IMAGE_MODEL, prompt: "a red bicycle", generation: { width: 512, height: 512, seed: 7 } },
        imageInvoker: fakeImageInvoker((r) => (captured = r)),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(captured?.prompt).toBe("a red bicycle");
    expect(captured?.generation).toMatchObject({ width: 512, height: 512, seed: 7 });
    expect(captured?.provider).toBe("amazon");
  });

  it("denies (429) on a cost gate BEFORE generating, and releases the reservation", async () => {
    // A cost gate below the per-image price is breached by the reservation.
    const db = makeDb(
      { models: [IMAGE_MODEL], reports: [] },
      [{ dimension: "cost", unit: "usd_micros", limit_value: 10_000 }],
    );
    let generated = false;
    const written = { calls: [] as { invocationId: string; images: Uint8Array[]; contentType: string }[] };
    const res = await handleCapabilityInvoke(
      imageDeps(db, written, {
        imageInvoker: fakeImageInvoker(() => (generated = true)),
      }),
    );
    expect(res.statusCode).toBe(429);
    expect(generated).toBe(false);
    expect(written.calls).toHaveLength(0);
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("releases the reservation and 502s when the image invoker throws (nothing written)", async () => {
    const db = makeDb({ models: [IMAGE_MODEL], reports: [] }, []);
    const written = { calls: [] as { invocationId: string; images: Uint8Array[]; contentType: string }[] };
    const res = await handleCapabilityInvoke(
      imageDeps(db, written, {
        imageInvoker: {
          async generateImage() {
            throw new Error("canvas exploded");
          },
        },
      }),
    );
    expect(res.statusCode).toBe(502);
    expect(written.calls).toHaveLength(0);
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("500s (releasing the reservation) if the image deps are not wired", async () => {
    const db = makeDb({ models: [IMAGE_MODEL], reports: [] }, []);
    const written = { calls: [] as { invocationId: string; images: Uint8Array[]; contentType: string }[] };
    const deps = imageDeps(db, written);
    delete (deps as Partial<CapabilityHandlerDeps>).imageInvoker;
    delete (deps as Partial<CapabilityHandlerDeps>).writeSyncOutput;
    const res = await handleCapabilityInvoke(deps);
    expect(res.statusCode).toBe(500);
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("rejects an image (sync-s3) model on the streaming route — not streamable", async () => {
    const db = makeDb({ models: [IMAGE_MODEL], reports: [] }, []);
    const written = { calls: [] as { invocationId: string; images: Uint8Array[]; contentType: string }[] };
    const res = await handleCapabilityInvokeStream(imageDeps(db, written));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a rejection");
    expect(res.response.statusCode).toBe(400);
    expect((res.response.body as { error: string }).error).toBe("output_not_streamable");
    // The pre-flight reservation was released, not stranded.
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });
});

describe("buildImageModelInput (Nova Canvas body)", () => {
  it("builds a TEXT_IMAGE body with one image at the requested size", () => {
    const body = buildImageModelInput({
      target: "amazon.nova-canvas-v1:0",
      region: "us-east-1",
      provider: "amazon",
      prompt: "a watercolor cat",
      generation: { width: 512, height: 512, seed: 7 },
      credentials: { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" },
    }) as {
      taskType: string;
      textToImageParams: { text: string };
      imageGenerationConfig: { numberOfImages: number; width: number; height: number; seed: number };
    };
    expect(body.taskType).toBe("TEXT_IMAGE");
    expect(body.textToImageParams.text).toBe("a watercolor cat");
    // numberOfImages is capped at 1 for this increment (plan §3.8).
    expect(body.imageGenerationConfig.numberOfImages).toBe(1);
    expect(body.imageGenerationConfig.width).toBe(512);
    expect(body.imageGenerationConfig.seed).toBe(7);
  });

  it("throws for a provider without a sync-image adapter", () => {
    expect(() =>
      buildImageModelInput({
        target: "anthropic.x",
        region: "us-east-1",
        provider: "anthropic",
        prompt: "x",
        credentials: { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" },
      }),
    ).toThrow(/not supported/);
  });
});
