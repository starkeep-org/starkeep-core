/**
 * `capability-store.ts` — the ledger/gate SQL layer.
 *
 * Two complementary harnesses:
 *
 *  - a RECORDING client that captures the emitted SQL text + bound parameters,
 *    so the hazards the module itself calls out are pinned: `sumForGate`'s
 *    hand-ordered parameter list (the reason SQL COALESCE had to be dropped), the
 *    `WHERE status = 'reserved'` guards, and the `app_id` predicate that is the
 *    only thing keeping a PUBLIC-SELECT table from leaking across apps;
 *  - the shared {@link InMemoryCapabilityDb}, which honours those predicates, so
 *    the same functions are also exercised for BEHAVIOUR (window boundaries,
 *    NULL→0, string coercion, reconcile's update-then-insert dance).
 */
import { describe, it, expect } from "vitest";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import type { Gate, Measurement } from "@starkeep/protocol-primitives";
import {
  loadCapabilityGrant,
  loadGrantedCapabilities,
  loadGates,
  loadModelOverrides,
  lookupInvocation,
  appendReportedOutput,
  reserve,
  reconcile,
  release,
  commitReservation,
  sumForGate,
  insertAsyncJob,
  loadAsyncJob,
  markAsyncJobStatus,
  type LedgerKey,
} from "../src/capability-store.js";
import { InMemoryCapabilityDb } from "./in-memory-capability-db.js";

/** Records every statement and replays scripted rows by SQL match. */
class RecordingClient implements DatabaseClient {
  readonly log: Array<{ sql: string; params: unknown[] }> = [];
  constructor(private readonly rowsFor: (sql: string) => Record<string, unknown>[] = () => []) {}
  async query(sql: string, params: unknown[] = []) {
    this.log.push({ sql, params });
    return { rows: this.rowsFor(sql) };
  }
  async end() {}
  last() {
    return this.log[this.log.length - 1]!;
  }
}

const KEY: LedgerKey = {
  invocationId: "inv-1",
  appId: "photos",
  capabilityName: "bedrock.invoke",
  provider: "anthropic",
  model: "anthropic.claude-haiku-4-5",
};

function gate(partial: Partial<Gate> & Pick<Gate, "dimension" | "unit" | "limit">): Gate {
  return {
    scope: {},
    window: { kind: "calendar", period: "month" },
    onExceed: "deny",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// sumForGate — the emitted SQL + parameter order
// ---------------------------------------------------------------------------

describe("sumForGate SQL", () => {
  const NOW = Date.UTC(2026, 6, 23, 15, 30); // 2026-07-23T15:30Z

  it("binds parameters in exactly the order the placeholders appear (no COALESCE shift)", async () => {
    const c = new RecordingClient(() => [{ total: "0" }]);
    await sumForGate(
      c,
      gate({
        dimension: "cost",
        unit: "usd_micros",
        limit: 20,
        scope: { appId: "photos", provider: "anthropic", model: "m-1" },
      }),
      NOW,
      "UTC",
    );
    const { sql, params } = c.last();
    // Placeholder order must line up 1:1 with the bound values — the module drops
    // SQL COALESCE precisely because a literal would become $n and shift these.
    expect(sql).toBe(
      'select sum("quantity") as "total" from "shared"."capability_ledger" ' +
        'where "dimension" = $1 and "unit" = $2 and "status" in ($3, $4) and "ts" >= $5 ' +
        'and "app_id" = $6 and "provider" = $7 and "model" = $8',
    );
    expect(params).toEqual([
      "cost",
      "usd_micros",
      "reserved",
      "committed",
      "2026-07-01T00:00:00.000Z", // month window start, UTC
      "photos",
      "anthropic",
      "m-1",
    ]);
    expect(sql).not.toMatch(/coalesce/i);
  });

  it("omits absent scope predicates, keeping the remaining placeholders contiguous", async () => {
    const c = new RecordingClient(() => [{ total: "0" }]);
    await sumForGate(
      c,
      gate({ dimension: "requests", unit: "all", limit: 5, scope: { model: "m-9" } }),
      NOW,
      "UTC",
    );
    const { sql, params } = c.last();
    expect(sql).not.toContain('"app_id"');
    expect(sql).not.toContain('"provider"');
    expect(sql).toContain('"model" = $6');
    expect(params).toHaveLength(6);
    expect(params[5]).toBe("m-9");
  });

  it("sums reserved + committed only (a released reservation drops out)", async () => {
    const c = new RecordingClient(() => [{ total: "0" }]);
    await sumForGate(c, gate({ dimension: "cost", unit: "usd_micros", limit: 1 }), NOW, "UTC");
    expect(c.last().params.slice(2, 4)).toEqual(["reserved", "committed"]);
    expect(c.last().params).not.toContain("released");
  });

  it("aligns the window start to the configured time zone", async () => {
    const c = new RecordingClient(() => [{ total: "0" }]);
    // 2026-07-01T02:00Z is still June 30 in Los Angeles, so the LA month window
    // starts 2026-06-01T00:00 local = 2026-06-01T07:00Z.
    await sumForGate(
      c,
      gate({ dimension: "cost", unit: "usd_micros", limit: 1 }),
      Date.UTC(2026, 6, 1, 2, 0),
      "America/Los_Angeles",
    );
    expect(c.last().params[4]).toBe("2026-06-01T07:00:00.000Z");
  });

  it("passes a burst window's now − seconds as the start", async () => {
    const c = new RecordingClient(() => [{ total: "0" }]);
    await sumForGate(
      c,
      gate({ dimension: "requests", unit: "all", limit: 3, window: { kind: "burst", seconds: 60 } }),
      NOW,
      "UTC",
    );
    expect(c.last().params[4]).toBe(new Date(NOW - 60_000).toISOString());
  });

  it("coalesces an empty window (SQL NULL) to 0 and coerces a numeric string", async () => {
    const g = gate({ dimension: "cost", unit: "usd_micros", limit: 1 });
    expect(await sumForGate(new RecordingClient(() => [{ total: null }]), g, NOW, "UTC")).toBe(0);
    // No row at all (defensive) is also 0.
    expect(await sumForGate(new RecordingClient(() => []), g, NOW, "UTC")).toBe(0);
    // pg hands numeric SUMs back as strings.
    expect(await sumForGate(new RecordingClient(() => [{ total: "12.5" }]), g, NOW, "UTC")).toBe(12.5);
    expect(await sumForGate(new RecordingClient(() => [{ total: 7 }]), g, NOW, "UTC")).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// sumForGate — window behaviour against a ts-aware ledger
// ---------------------------------------------------------------------------

describe("sumForGate windows (ts-aware ledger)", () => {
  const NOW = Date.UTC(2026, 6, 23, 12, 0);

  function dbAt(nowMs: number) {
    return new InMemoryCapabilityDb({ now: () => nowMs });
  }

  it("excludes rows older than a burst window and includes rows inside it", async () => {
    const db = dbAt(NOW);
    db.now = () => NOW - 120_000; // two minutes ago
    db.seedLedger({ dimension: "requests", unit: "all", quantity: 1 });
    db.now = () => NOW - 10_000; // ten seconds ago
    db.seedLedger({ dimension: "requests", unit: "all", quantity: 1 });
    db.now = () => NOW;

    const burst = gate({
      dimension: "requests",
      unit: "all",
      limit: 5,
      window: { kind: "burst", seconds: 60 },
    });
    expect(await sumForGate(db, burst, NOW, "UTC")).toBe(1);
    // A wider burst window catches both.
    expect(
      await sumForGate(db, { ...burst, window: { kind: "burst", seconds: 600 } }, NOW, "UTC"),
    ).toBe(2);
  });

  it("rows age out as the burst window slides forward", async () => {
    const db = dbAt(NOW);
    db.seedLedger({ dimension: "requests", unit: "all", quantity: 1 });
    const burst = gate({
      dimension: "requests",
      unit: "all",
      limit: 5,
      window: { kind: "burst", seconds: 60 },
    });
    expect(await sumForGate(db, burst, NOW + 30_000, "UTC")).toBe(1);
    expect(await sumForGate(db, burst, NOW + 61_000, "UTC")).toBe(0);
  });

  it("a calendar month rollover resets the window sum", async () => {
    const db = dbAt(NOW);
    db.now = () => Date.UTC(2026, 5, 15); // June — the previous month
    db.seedLedger({ dimension: "cost", unit: "usd_micros", quantity: 19 });

    const monthly = gate({ dimension: "cost", unit: "usd_micros", limit: 20 });
    // Still June: the $19 counts and the $20 budget is nearly spent.
    expect(await sumForGate(db, monthly, Date.UTC(2026, 5, 20), "UTC")).toBe(19);

    // July: June's spend has rolled out of the window entirely.
    expect(await sumForGate(db, monthly, NOW, "UTC")).toBe(0);
    db.now = () => Date.UTC(2026, 6, 2);
    db.seedLedger({ dimension: "cost", unit: "usd_micros", quantity: 3 });
    expect(await sumForGate(db, monthly, NOW, "UTC")).toBe(3);
  });

  it("honours a non-UTC time zone at the month boundary", async () => {
    // The row lands 2026-06-30T23:00Z — the last hour of June in UTC, and mid-
    // afternoon of June 30 in Los Angeles. Both call it June; the two zones
    // disagree only about where the CURRENT month starts.
    const db = new InMemoryCapabilityDb({ now: () => Date.UTC(2026, 5, 30, 23, 0) });
    db.seedLedger({ dimension: "cost", unit: "usd_micros", quantity: 5 });
    const monthly = gate({ dimension: "cost", unit: "usd_micros", limit: 20 });
    const now = Date.UTC(2026, 6, 1, 3, 0);
    // UTC says it is already July → the June row is outside the window.
    expect(await sumForGate(db, monthly, now, "UTC")).toBe(0);
    // Los Angeles (UTC-7) says it is still June 30 → the row is in-window.
    expect(await sumForGate(db, monthly, now, "America/Los_Angeles")).toBe(5);
  });

  it("scopes the sum by app / provider / model", async () => {
    const db = dbAt(NOW);
    db.seedLedger({ dimension: "cost", unit: "usd_micros", quantity: 1, app_id: "photos" });
    db.seedLedger({ dimension: "cost", unit: "usd_micros", quantity: 10, app_id: "notes" });
    db.seedLedger({ dimension: "cost", unit: "usd_micros", quantity: 100, provider: "amazon", app_id: "photos" });

    expect(await sumForGate(db, gate({ dimension: "cost", unit: "usd_micros", limit: 1 }), NOW, "UTC")).toBe(111);
    expect(
      await sumForGate(db, gate({ dimension: "cost", unit: "usd_micros", limit: 1, scope: { appId: "photos" } }), NOW, "UTC"),
    ).toBe(101);
    expect(
      await sumForGate(
        db,
        gate({ dimension: "cost", unit: "usd_micros", limit: 1, scope: { appId: "photos", provider: "amazon" } }),
        NOW,
        "UTC",
      ),
    ).toBe(100);
  });

  it("excludes released reservations from the window sum", async () => {
    const db = dbAt(NOW);
    await reserve(db, KEY, [{ dimension: "cost", unit: "usd_micros", quantity: 4 }]);
    const g = gate({ dimension: "cost", unit: "usd_micros", limit: 10 });
    expect(await sumForGate(db, g, NOW, "UTC")).toBe(4);
    await release(db, KEY.invocationId);
    expect(await sumForGate(db, g, NOW, "UTC")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reserve / reconcile / release / commit
// ---------------------------------------------------------------------------

describe("reserve", () => {
  it("writes one distinct reserved row per measurement (no shared counter)", async () => {
    const db = new InMemoryCapabilityDb();
    const measurements: Measurement[] = [
      { dimension: "requests", unit: "all", quantity: 1 },
      { dimension: "output", unit: "tokens", quantity: 1024 },
    ];
    await reserve(db, KEY, measurements);
    expect(db.ledger).toHaveLength(2);
    expect(new Set(db.ledger.map((r) => r.id)).size).toBe(2);
    expect(db.ledger.every((r) => r.status === "reserved")).toBe(true);
    expect(db.ledger.every((r) => r.invocation_id === "inv-1")).toBe(true);
    expect(db.ledger.every((r) => r.app_id === "photos")).toBe(true);
  });

  it("is a no-op for an empty measurement set", async () => {
    const db = new InMemoryCapabilityDb();
    await reserve(db, KEY, []);
    expect(db.log).toHaveLength(0);
  });
});

describe("reconcile", () => {
  it("promotes the reserved row to committed with the trued-up quantity", async () => {
    const db = new InMemoryCapabilityDb();
    await reserve(db, KEY, [{ dimension: "output", unit: "tokens", quantity: 1024 }]);
    await reconcile(db, KEY, [{ dimension: "output", unit: "tokens", quantity: 8 }]);
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]).toMatchObject({ status: "committed", quantity: 8 });
  });

  it("INSERTS a post-call-only dimension the reservation never carried", async () => {
    // `output:bytes` is unknown pre-call, so no reserved row exists to promote —
    // the update matches nothing and the count probe forces an insert.
    const db = new InMemoryCapabilityDb();
    await reserve(db, KEY, [{ dimension: "output", unit: "tokens", quantity: 1024 }]);
    await reconcile(db, KEY, [
      { dimension: "output", unit: "tokens", quantity: 8 },
      { dimension: "output", unit: "bytes", quantity: 300 },
    ]);
    const bytes = db.ledger.filter((r) => r.dimension === "output" && r.unit === "bytes");
    expect(bytes).toHaveLength(1);
    expect(bytes[0]).toMatchObject({ status: "committed", quantity: 300, app_id: "photos" });
  });

  it("does not double-insert when a committed row already exists (replayed reconcile)", async () => {
    const db = new InMemoryCapabilityDb();
    await reserve(db, KEY, [{ dimension: "output", unit: "tokens", quantity: 1024 }]);
    await reconcile(db, KEY, [{ dimension: "output", unit: "tokens", quantity: 8 }]);
    await reconcile(db, KEY, [{ dimension: "output", unit: "tokens", quantity: 8 }]);
    expect(db.ledger.filter((r) => r.dimension === "output" && r.unit === "tokens")).toHaveLength(1);
  });

  it("guards the promotion on status = reserved, so a released row is not resurrected", async () => {
    const c = new RecordingClient((sql) => (sql.startsWith("select count") ? [{ n: "1" }] : []));
    await reconcile(c, KEY, [{ dimension: "output", unit: "tokens", quantity: 8 }]);
    const upd = c.log.find((q) => q.sql.startsWith("update"))!;
    // set quantity, set status, then WHERE invocation_id / dimension / unit /
    // status — the trailing 'reserved' is the guard.
    expect(upd.params).toEqual([8, "committed", "inv-1", "output", "tokens", "reserved"]);
  });
});

describe("release / commitReservation status guards", () => {
  it("release only moves reserved rows; committed rows are untouched", async () => {
    const db = new InMemoryCapabilityDb();
    await reserve(db, KEY, [
      { dimension: "requests", unit: "all", quantity: 1 },
      { dimension: "output", unit: "tokens", quantity: 100 },
    ]);
    await reconcile(db, KEY, [{ dimension: "requests", unit: "all", quantity: 1 }]);
    await release(db, KEY.invocationId);
    const byDim = Object.fromEntries(db.ledger.map((r) => [r.dimension, r.status]));
    expect(byDim.requests).toBe("committed"); // already trued up — stays
    expect(byDim.output).toBe("released");
  });

  it("commitReservation flips reserved → committed and is idempotent on a double poll", async () => {
    const db = new InMemoryCapabilityDb();
    await reserve(db, KEY, [{ dimension: "output", unit: "duration_ms", quantity: 6 }]);
    await commitReservation(db, KEY.invocationId);
    expect(db.ledger[0]!.status).toBe("committed");
    // A second (racing) poll finds nothing still reserved — no change, no error.
    await commitReservation(db, KEY.invocationId);
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]!.status).toBe("committed");
  });

  it("release after commit cannot un-commit (the WHERE status guard holds)", async () => {
    const db = new InMemoryCapabilityDb();
    await reserve(db, KEY, [{ dimension: "output", unit: "duration_ms", quantity: 6 }]);
    await commitReservation(db, KEY.invocationId);
    await release(db, KEY.invocationId);
    expect(db.ledger[0]!.status).toBe("committed");
  });

  it("both statements carry the reserved guard in their SQL", async () => {
    const c = new RecordingClient();
    await release(c, "inv-x");
    expect(c.last().params).toEqual(["released", "inv-x", "reserved"]);
    await commitReservation(c, "inv-x");
    expect(c.last().params).toEqual(["committed", "inv-x", "reserved"]);
  });

  it("scopes the update to one invocation, never the whole app", async () => {
    const db = new InMemoryCapabilityDb();
    await reserve(db, KEY, [{ dimension: "requests", unit: "all", quantity: 1 }]);
    await reserve(db, { ...KEY, invocationId: "inv-2" }, [
      { dimension: "requests", unit: "all", quantity: 1 },
    ]);
    await release(db, "inv-1");
    expect(db.ledger.find((r) => r.invocation_id === "inv-1")!.status).toBe("released");
    expect(db.ledger.find((r) => r.invocation_id === "inv-2")!.status).toBe("reserved");
  });
});

// ---------------------------------------------------------------------------
// Cross-app isolation on PUBLIC-SELECT tables
// ---------------------------------------------------------------------------

describe("app_id scoping (PUBLIC SELECT tables)", () => {
  it("lookupInvocation refuses another app's invocation", async () => {
    const db = new InMemoryCapabilityDb();
    await reserve(db, KEY, [{ dimension: "requests", unit: "all", quantity: 1 }]);
    expect(await lookupInvocation(db, "inv-1", "photos")).toEqual({
      provider: "anthropic",
      model: "anthropic.claude-haiku-4-5",
      capabilityName: "bedrock.invoke",
    });
    expect(await lookupInvocation(db, "inv-1", "notes")).toBeNull();
    // And the filter really is in the SQL, not just the fake.
    const q = db.log[db.log.length - 1]!;
    expect(q.text).toContain('"app_id" = $2');
    expect(q.values).toEqual(["inv-1", "notes", 1]); // + the LIMIT binding
  });

  it("lookupInvocation returns null on a partially-populated row", async () => {
    const c = new RecordingClient(() => [{ provider: "anthropic" }]);
    expect(await lookupInvocation(c, "inv-1", "photos")).toBeNull();
  });

  it("loadAsyncJob refuses another app's job", async () => {
    const db = new InMemoryCapabilityDb();
    await insertAsyncJob(db, {
      invocationId: "inv-a",
      appId: "photos",
      capabilityName: "bedrock.invoke",
      provider: "amazon",
      model: "amazon.nova-reel-v1:1",
      invocationArn: "arn:aws:bedrock:us-east-1:1:async-invoke/x",
      outputBucket: "stk-files-1",
      outputKeyPrefix: "apps/photos/syncable/capability-async/inv-a",
      status: "running",
    });
    const mine = await loadAsyncJob(db, "inv-a", "photos");
    expect(mine).toMatchObject({
      invocationId: "inv-a",
      appId: "photos",
      invocationArn: "arn:aws:bedrock:us-east-1:1:async-invoke/x",
      outputKeyPrefix: "apps/photos/syncable/capability-async/inv-a",
      status: "running",
    });
    expect(await loadAsyncJob(db, "inv-a", "notes")).toBeNull();
    expect(db.log[db.log.length - 1]!.text).toContain('"app_id" = $2');
  });

  it("loadCapabilityGrant / loadGrantedCapabilities bind the app id first", async () => {
    const c = new RecordingClient(() => []);
    await loadCapabilityGrant(c, "photos", "bedrock.invoke");
    expect(c.last().sql).toContain('"app_id" = $1');
    expect(c.last().params).toEqual(["photos", "bedrock.invoke"]);
    await loadGrantedCapabilities(c, "photos");
    expect(c.last().params).toEqual(["photos"]);
  });
});

describe("markAsyncJobStatus", () => {
  it("transitions only from running, so a losing racer cannot re-mark a terminal job", async () => {
    const db = new InMemoryCapabilityDb();
    await insertAsyncJob(db, {
      invocationId: "inv-a",
      appId: "photos",
      capabilityName: "bedrock.invoke",
      provider: "amazon",
      model: "amazon.nova-reel-v1:1",
      invocationArn: "arn",
      outputBucket: "b",
      outputKeyPrefix: "p",
      status: "running",
    });
    await markAsyncJobStatus(db, "inv-a", "completed");
    expect(db.asyncJobs[0]!.status).toBe("completed");
    // The loser of the race tries to mark it failed — the guard rejects it.
    await markAsyncJobStatus(db, "inv-a", "failed");
    expect(db.asyncJobs[0]!.status).toBe("completed");
    expect(db.log[db.log.length - 1]!.values).toEqual(["failed", "inv-a", "running"]);
  });
});

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

describe("loadGates row mapping", () => {
  async function loadOne(row: Record<string, unknown>): Promise<Gate> {
    const c = new RecordingClient(() => [row]);
    const gates = await loadGates(c, "bedrock.invoke");
    return gates[0]!;
  }

  const base = {
    id: "g-1",
    dimension: "cost",
    unit: "usd_micros",
    scope_provider: null,
    scope_model: null,
    scope_app_id: null,
    window_kind: "calendar",
    window_period: "month",
    window_seconds: null,
    limit_value: 20,
    on_exceed: "deny",
  };

  it("maps a calendar gate with wildcard scope", async () => {
    const g = await loadOne(base);
    expect(g).toEqual({
      id: "g-1",
      dimension: "cost",
      unit: "usd_micros",
      scope: {},
      window: { kind: "calendar", period: "month" },
      limit: 20,
      onExceed: "deny",
    });
  });

  it("maps every set scope column and leaves nulls as wildcards", async () => {
    const g = await loadOne({
      ...base,
      scope_provider: "anthropic",
      scope_model: "anthropic.claude-haiku-4-5",
      scope_app_id: "photos",
    });
    expect(g.scope).toEqual({
      provider: "anthropic",
      model: "anthropic.claude-haiku-4-5",
      appId: "photos",
    });
  });

  it("defaults a burst gate's NULL seconds to 0 (window collapses to 'now')", async () => {
    const g = await loadOne({ ...base, window_kind: "burst", window_period: null, window_seconds: null });
    expect(g.window).toEqual({ kind: "burst", seconds: 0 });
  });

  it("keeps a burst gate's seconds when set", async () => {
    const g = await loadOne({ ...base, window_kind: "burst", window_period: null, window_seconds: 60 });
    expect(g.window).toEqual({ kind: "burst", seconds: 60 });
  });

  it("defaults a calendar gate's NULL period to month, not week", async () => {
    const g = await loadOne({ ...base, window_period: null });
    expect(g.window).toEqual({ kind: "calendar", period: "month" });
  });

  it("maps a week period", async () => {
    const g = await loadOne({ ...base, window_period: "week" });
    expect(g.window).toEqual({ kind: "calendar", period: "week" });
  });

  it("coerces a numeric-string limit (pg NUMERIC) to a number", async () => {
    const g = await loadOne({ ...base, limit_value: "20.50" });
    expect(g.limit).toBe(20.5);
    expect(typeof g.limit).toBe("number");
  });

  it("always reports onExceed = deny (the only mode this increment supports)", async () => {
    const g = await loadOne({ ...base, on_exceed: "warn" });
    expect(g.onExceed).toBe("deny");
  });

  it("filters by capability name", async () => {
    const c = new RecordingClient(() => []);
    await loadGates(c, "bedrock.invoke");
    expect(c.last().params).toEqual(["bedrock.invoke"]);
  });
});

describe("loadModelOverrides row mapping", () => {
  async function loadOne(row: Record<string, unknown>) {
    const c = new RecordingClient(() => [row]);
    const [o] = await loadModelOverrides(c);
    return o!;
  }

  const base = {
    model_id: "anthropic.claude-haiku-4-5",
    provider: null,
    inference_profile_id: null,
    inference_profile_cleared: null,
    vision: null,
    output_modality: null,
    pricing_json: null,
    estimates_json: null,
  };

  it("maps a bare row to modelId only (every unset field falls through)", async () => {
    expect(await loadOne(base)).toEqual({ modelId: "anthropic.claude-haiku-4-5" });
  });

  it("inference_profile_cleared wins over a stored profile id (explicit null)", async () => {
    const o = await loadOne({
      ...base,
      inference_profile_id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      inference_profile_cleared: true,
    });
    expect(o.inferenceProfileId).toBeNull();
    expect("inferenceProfileId" in o).toBe(true);
  });

  it("uses inference_profile_id when not cleared", async () => {
    const o = await loadOne({
      ...base,
      inference_profile_id: "us.amazon.nova-lite-v1:0",
      inference_profile_cleared: false,
    });
    expect(o.inferenceProfileId).toBe("us.amazon.nova-lite-v1:0");
  });

  it("distinguishes vision:false from vision unset (null)", async () => {
    expect(await loadOne({ ...base, vision: false })).toMatchObject({ vision: false });
    expect("vision" in (await loadOne({ ...base, vision: null }))).toBe(false);
  });

  it("carries provider / output_modality / pricing / estimates when set", async () => {
    const o = await loadOne({
      ...base,
      provider: "amazon",
      output_modality: "image",
      pricing_json: JSON.stringify({ "requests:image": 0.05 }),
      estimates_json: JSON.stringify({ imageTokens: 900 }),
    });
    expect(o).toMatchObject({
      provider: "amazon",
      outputModality: "image",
      pricing: { "requests:image": 0.05 },
      estimates: { imageTokens: 900 },
    });
  });

  it("maps malformed JSON to undefined rather than throwing", async () => {
    const o = await loadOne({ ...base, pricing_json: "{not json", estimates_json: "[[" });
    expect(o.pricing).toBeUndefined();
    expect(o.estimates).toBeUndefined();
    expect(o.modelId).toBe("anthropic.claude-haiku-4-5");
  });
});

describe("grant JSON coercion", () => {
  it("treats missing / malformed / non-array JSON as an empty list", async () => {
    const missing = new RecordingClient(() => [{}]);
    expect(await loadCapabilityGrant(missing, "photos", "bedrock.invoke")).toEqual({
      appId: "photos",
      capabilityName: "bedrock.invoke",
      models: [],
      reports: [],
    });
    const malformed = new RecordingClient(() => [{ models_json: "{oops", reports_json: '{"a":1}' }]);
    const g = await loadCapabilityGrant(malformed, "photos", "bedrock.invoke");
    expect(g).toMatchObject({ models: [], reports: [] });
  });

  it("returns null when the app has no grant row", async () => {
    expect(await loadCapabilityGrant(new RecordingClient(() => []), "photos", "bedrock.invoke")).toBeNull();
  });

  it("maps every granted capability for an app", async () => {
    const c = new RecordingClient(() => [
      { capability_name: "bedrock.invoke", models_json: '["m1"]', reports_json: '["input:pixels"]' },
    ]);
    expect(await loadGrantedCapabilities(c, "photos")).toEqual([
      {
        appId: "photos",
        capabilityName: "bedrock.invoke",
        models: ["m1"],
        reports: ["input:pixels"],
      },
    ]);
  });
});

describe("appendReportedOutput", () => {
  it("appends committed rows carrying the invocation's provider/model", async () => {
    const db = new InMemoryCapabilityDb();
    await appendReportedOutput(db, KEY, [{ dimension: "output", unit: "pixels", quantity: 4 }]);
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]).toMatchObject({
      status: "committed",
      dimension: "output",
      unit: "pixels",
      quantity: 4,
      provider: "anthropic",
      model: "anthropic.claude-haiku-4-5",
      invocation_id: "inv-1",
    });
  });

  it("writes nothing for an empty measurement list", async () => {
    const db = new InMemoryCapabilityDb();
    await appendReportedOutput(db, KEY, []);
    expect(db.log).toHaveLength(0);
  });
});
