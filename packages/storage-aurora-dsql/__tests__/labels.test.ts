/**
 * Labels on the DSQL adapter.
 *
 * The SQL itself is built in `@starkeep/storage-adapter` and pinned there
 * against both dialects, so what is left for this file is everything the
 * adapter adds on top and DSQL makes necessary:
 *
 *   - **OCC retry.** DSQL aborts transactions that race, so every label
 *     statement is wrapped. A retry has to converge rather than compound, and
 *     a multi-statement retraction has to retry as one unit rather than
 *     re-running a prefix.
 *   - **Short-circuits.** An empty batch and an unsatisfiable query must issue
 *     no SQL at all — a round trip to DSQL is billed whether or not it can
 *     match anything.
 *   - **Row mapping**, since rows arrive from `pg` as loose objects.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHLCClock, serializeHLC, type StarkeepId } from "@starkeep/protocol-primitives";
import { encodeLabelScanCursor } from "@starkeep/storage-adapter";
import { AuroraDsqlDatabaseAdapter } from "../src/adapter.js";
import type { DatabaseClient, DatabaseClientFactory } from "../src/types.js";

/** A DSQL OCC-conflict shaped error (pg surfaces the code on the error). */
function occConflict(): Error {
  return Object.assign(new Error("change conflicts with another transaction"), {
    code: "OC001",
  });
}

class FakeClient implements DatabaseClient {
  calls: { text: string; values?: unknown[] }[] = [];
  responses: Array<{ match: RegExp; rows: Record<string, unknown>[] }> = [];
  conflicts: Array<{ match: RegExp; remaining: number }> = [];
  ended = false;

  conflictOnce(match: RegExp, times = 1) {
    this.conflicts.push({ match, remaining: times });
  }

  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    const conflict = this.conflicts.find((c) => c.remaining > 0 && c.match.test(text));
    if (conflict) {
      conflict.remaining--;
      throw occConflict();
    }
    const canned = this.responses.find((r) => r.match.test(text));
    return { rows: canned?.rows ?? [] };
  }

  async end() {
    this.ended = true;
  }

  texts(): string[] {
    return this.calls.map((c) => c.text);
  }
}

function factoryOf(client: FakeClient): DatabaseClientFactory {
  return { createClient: async () => client };
}

const clock = createHLCClock({ nodeId: "node-test", wallClockFunction: () => 1000 });
const rid = (s: string) => s as StarkeepId;
const HLC = clock.now();

function labelRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record_id: "rec1",
    app_id: "alpha",
    key: "quality",
    value: "high",
    record_type: "image/jpeg",
    created_at: serializeHLC(HLC),
    updated_at: serializeHLC(HLC),
    node_id: "node-test",
    deleted_at: null,
    ...over,
  };
}

const LABELS_INSERT = /insert into "shared"\."record_labels"/;
const LABELS_UPDATE = /update "shared"\."record_labels"/;
const LABELS_SELECT = /select \* from "shared"\."record_labels"/;

let client: FakeClient;
let adapter: AuroraDsqlDatabaseAdapter;

beforeEach(async () => {
  client = new FakeClient();
  adapter = new AuroraDsqlDatabaseAdapter(
    { hostname: "fake.dsql", region: "us-east-1" },
    factoryOf(client),
  );
  await adapter.init();
});

const upsert = {
  recordId: rid("rec1"),
  appId: "alpha",
  key: "quality",
  value: "high" as string | null,
  recordType: "image/jpeg",
  hlc: HLC,
};

describe("upsertLabels", () => {
  it("issues exactly one statement for a whole batch", async () => {
    await adapter.upsertLabels([
      upsert,
      { ...upsert, recordId: rid("rec2") },
      { ...upsert, recordId: rid("rec3") },
    ]);
    expect(client.calls.filter((c) => LABELS_INSERT.test(c.text))).toHaveLength(1);
  });

  it("issues no SQL at all for an empty batch", async () => {
    // A round trip to DSQL is billed whether or not it does anything.
    await adapter.upsertLabels([]);
    expect(client.calls).toHaveLength(0);
  });

  it("replays the same statement verbatim after an OCC conflict", async () => {
    // The upsert is value-independent — every column comes from the caller's
    // input, not from a prior read — so a retry converges instead of
    // compounding. This is what makes it safe under withOccRetry with no
    // read-modify-write round trip.
    client.conflictOnce(LABELS_INSERT);
    await adapter.upsertLabels([upsert]);

    const inserts = client.calls.filter((c) => LABELS_INSERT.test(c.text));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].text).toBe(inserts[1].text);
    expect(inserts[0].values).toEqual(inserts[1].values);
  });

  it("never touches shared.records", async () => {
    await adapter.upsertLabels([upsert]);
    expect(client.texts().some((t) => /"shared"\."records"/.test(t))).toBe(false);
  });
});

describe("retractLabels", () => {
  it("issues one UPDATE per retraction, all inside a single retry unit", async () => {
    await adapter.retractLabels([
      { recordId: rid("rec1"), appId: "alpha", key: "k", hlc: HLC },
      { recordId: rid("rec2"), appId: "alpha", key: "k", hlc: HLC },
    ]);
    expect(client.calls.filter((c) => LABELS_UPDATE.test(c.text))).toHaveLength(2);
  });

  it("retries the whole batch, not a suffix, when a later statement conflicts", async () => {
    // DSQL reports a conflict at commit, so retrying anything narrower than
    // the unit that failed would leave a half-applied batch. Idempotence by
    // primary key is what makes the replay of the first statement harmless.
    client.conflictOnce(LABELS_UPDATE);
    await adapter.retractLabels([
      { recordId: rid("rec1"), appId: "alpha", key: "k", hlc: HLC },
      { recordId: rid("rec2"), appId: "alpha", key: "k", hlc: HLC },
    ]);

    const updates = client.calls.filter((c) => LABELS_UPDATE.test(c.text));
    // First attempt conflicts on statement 1; the replay issues both.
    expect(updates).toHaveLength(3);
    expect(updates[1].values).toContain("rec1");
    expect(updates[2].values).toContain("rec2");
  });

  it("issues no SQL for an empty batch", async () => {
    await adapter.retractLabels([]);
    expect(client.calls).toHaveLength(0);
  });
});

describe("findByLabel", () => {
  it("maps rows and pages with the composite cursor", async () => {
    client.responses.push({
      match: LABELS_SELECT,
      rows: [
        labelRow({ record_id: "rec1", value: null }),
        labelRow({ record_id: "rec2", value: "a" }),
        // The limit + 1 probe row: present, so hasMore is true and this row
        // must not be returned.
        labelRow({ record_id: "rec3", value: "b" }),
      ],
    });

    const page = await adapter.findByLabel({ appId: "alpha", key: "quality", limit: 2 });
    expect(page.labels.map((l) => l.recordId)).toEqual(["rec1", "rec2"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    expect(page.labels[0].value).toBeNull();
    expect(page.labels[0].recordType).toBe("image/jpeg");
    expect(page.labels[0].updatedAt).toEqual(HLC);
  });

  it("asks DSQL for nothing when the caller has no readable types", async () => {
    const page = await adapter.findByLabel({
      appId: "alpha",
      key: "k",
      readableTypes: new Set(),
    });
    expect(page).toEqual({ labels: [], nextCursor: null, hasMore: false });
    expect(client.calls).toHaveLength(0);
  });

  it("retries a conflicted read", async () => {
    client.conflictOnce(LABELS_SELECT);
    client.responses.push({ match: LABELS_SELECT, rows: [labelRow()] });
    const page = await adapter.findByLabel({ appId: "alpha", key: "quality" });
    expect(page.labels).toHaveLength(1);
    expect(client.calls.filter((c) => LABELS_SELECT.test(c.text))).toHaveLength(2);
  });
});

describe("the sync-facing surface", () => {
  it("putLabel writes the snapshot's own timestamps, tombstone included", async () => {
    const deletedAt = clock.now();
    await adapter.putLabel({
      recordId: rid("rec1"),
      appId: "alpha",
      key: "k",
      value: null,
      recordType: "image/jpeg",
      createdAt: HLC,
      updatedAt: deletedAt,
      nodeId: deletedAt.nodeId,
      deletedAt,
    });
    const [call] = client.calls;
    expect(call.values).toContain(serializeHLC(deletedAt));
    expect(call.values).toContain(serializeHLC(HLC));
  });

  it("getLabel returns null on a miss and a mapped row on a hit", async () => {
    expect(await adapter.getLabel(rid("rec1"), "alpha", "k")).toBeNull();
    client.responses.push({ match: LABELS_SELECT, rows: [labelRow({ deleted_at: serializeHLC(HLC) })] });
    const found = await adapter.getLabel(rid("rec1"), "alpha", "quality");
    // Tombstones come back: that is what a later arrival is compared against.
    expect(found!.deletedAt).toEqual(HLC);
  });

  it("queryLabels pages by primary key and hands back a scan cursor", async () => {
    client.responses.push({
      match: LABELS_SELECT,
      rows: [
        labelRow({ record_id: "rec1" }),
        labelRow({ record_id: "rec2" }),
      ],
    });
    const page = await adapter.queryLabels({ limit: 1 });
    expect(page.labels.map((l) => l.recordId)).toEqual(["rec1"]);
    expect(page.hasMore).toBe(true);
    // All four primary-key columns, `value` included. Without it the cursor is
    // not unique, and a page boundary landing inside one key's values skips
    // every sibling after the first — sync losing rows with nothing to notice.
    expect(page.nextCursor).toBe(
      encodeLabelScanCursor({
        recordId: rid("rec1"),
        appId: "alpha",
        key: "quality",
        value: "high",
      }),
    );
  });

  it("getLabelNodeWatermarks deserializes the per-node fold", async () => {
    client.responses.push({
      match: /select "node_id", max\("updated_at"\)/,
      rows: [{ node_id: "node-test", max_updated_at: serializeHLC(HLC) }],
    });
    expect(await adapter.getLabelNodeWatermarks()).toEqual({ "node-test": HLC });
  });

  it("tombstoneLabelsForRecord is one statement with no app_id predicate", async () => {
    await adapter.tombstoneLabelsForRecord(rid("rec1"), HLC);
    const [call] = client.calls;
    expect(call.text).toMatch(LABELS_UPDATE);
    expect(call.text).not.toMatch(/"app_id" = /);
    expect(call.values).toContain("rec1");
  });
});
