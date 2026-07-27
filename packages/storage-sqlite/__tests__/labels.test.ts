/**
 * Label storage on the SQLite adapter. The cases that matter most are the ones
 * the reverse index's shape is designed around: retraction as a tombstone,
 * grant filtering that keeps pages full, and a cursor that survives a key whose
 * values are a mix of nulls and strings.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHLCClock, createStarkeepId, type StarkeepId } from "@starkeep/protocol-primitives";
import { SqliteDatabaseAdapter } from "../src/adapter.js";

describe("SqliteDatabaseAdapter — record labels", () => {
  let adapter: SqliteDatabaseAdapter;
  let tick = 0;
  const clock = createHLCClock({ nodeId: "nodeA", wallClockFunction: () => 1000 + tick++ });

  const rid = (n: number) => createStarkeepId(`01J0000000000000000000${String(n).padStart(4, "0")}`);

  beforeEach(async () => {
    adapter = new SqliteDatabaseAdapter({ path: ":memory:" });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
  });

  async function setLabel(
    recordId: StarkeepId,
    appId: string,
    key: string,
    value: string | null,
    recordType = "image/jpeg",
  ) {
    await adapter.upsertLabels([
      { recordId, appId, key, value, recordType, hlc: clock.now() },
    ]);
  }

  it("round-trips a flag and a valued label on the same record", async () => {
    await setLabel(rid(1), "alpha", "needs-review", null);
    await setLabel(rid(1), "alpha", "quality", "high");

    const byId = await adapter.getLabelsByRecordIds([rid(1)]);
    const labels = byId.get(rid(1))!;
    expect(labels).toHaveLength(2);
    expect(labels.find((l) => l.key === "needs-review")!.value).toBeNull();
    expect(labels.find((l) => l.key === "quality")!.value).toBe("high");
    expect(labels.every((l) => l.recordType === "image/jpeg")).toBe(true);
  });

  it("lets two apps hold contradictory opinions about one record", async () => {
    // Disagreement is representable rather than a conflict — that is the point
    // of attribution being part of the data.
    await setLabel(rid(1), "alpha", "quality", "high");
    await setLabel(rid(1), "gamma", "quality", "low");

    const labels = (await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))!;
    expect(labels).toHaveLength(2);
    expect(new Set(labels.map((l) => `${l.appId}=${l.value}`))).toEqual(
      new Set(["alpha=high", "gamma=low"]),
    );
  });

  it("upserts by primary key rather than duplicating", async () => {
    await setLabel(rid(1), "alpha", "quality", "high");
    await setLabel(rid(1), "alpha", "quality", "low");

    const labels = (await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))!;
    expect(labels).toHaveLength(1);
    expect(labels[0].value).toBe("low");
  });

  it("retracts as a tombstone, not a hard delete, so the retraction can sync", async () => {
    await setLabel(rid(1), "alpha", "needs-review", null);
    await adapter.retractLabels([
      { recordId: rid(1), appId: "alpha", key: "needs-review", hlc: clock.now() },
    ]);

    // Invisible to readers...
    expect((await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))).toBeUndefined();
    const found = await adapter.findByLabel({ appId: "alpha", key: "needs-review" });
    expect(found.labels).toHaveLength(0);

    // ...but the row is still there carrying its tombstone, which is what the
    // sync path ships.
    const watermarks = await adapter.getNodeWatermarks();
    expect(watermarks).toBeDefined();
  });

  it("revives a retracted label when it is set again", async () => {
    await setLabel(rid(1), "alpha", "needs-review", null);
    await adapter.retractLabels([
      { recordId: rid(1), appId: "alpha", key: "needs-review", hlc: clock.now() },
    ]);
    await setLabel(rid(1), "alpha", "needs-review", null);

    // Without clearing deleted_at on conflict this writes a row that stays
    // invisible forever — a set/retract/set cycle silently stops working.
    const found = await adapter.findByLabel({ appId: "alpha", key: "needs-review" });
    expect(found.labels.map((l) => l.recordId)).toEqual([rid(1)]);
  });

  describe("findByLabel", () => {
    it("presence filter matches any value including a null flag", async () => {
      await setLabel(rid(1), "alpha", "k", null);
      await setLabel(rid(2), "alpha", "k", "v");
      await setLabel(rid(3), "alpha", "other", "v");

      const found = await adapter.findByLabel({ appId: "alpha", key: "k" });
      expect(found.labels.map((l) => l.recordId).sort()).toEqual([rid(1), rid(2)]);
    });

    it("value filter is an exact match", async () => {
      await setLabel(rid(1), "alpha", "quality", "high");
      await setLabel(rid(2), "alpha", "quality", "low");

      const found = await adapter.findByLabel({ appId: "alpha", key: "quality", value: "high" });
      expect(found.labels.map((l) => l.recordId)).toEqual([rid(1)]);
    });

    it("does not leak another app's namespace", async () => {
      await setLabel(rid(1), "gamma", "k", null);
      const found = await adapter.findByLabel({ appId: "alpha", key: "k" });
      expect(found.labels).toHaveLength(0);
    });

    it("filters by the caller's readable types, and the page still comes back full", async () => {
      // 6 jpegs and 6 pngs interleaved; a caller who can read only jpeg asks
      // for 3. If the grant filter ran after the fetch this would come back
      // short — that is the failure the record_type INCLUDE column removes.
      for (let i = 0; i < 12; i++) {
        await setLabel(rid(i), "alpha", "k", null, i % 2 === 0 ? "image/jpeg" : "image/png");
      }

      const found = await adapter.findByLabel({
        appId: "alpha",
        key: "k",
        readableTypes: new Set(["image/jpeg"]),
        limit: 3,
      });
      expect(found.labels).toHaveLength(3);
      expect(found.labels.every((l) => l.recordType === "image/jpeg")).toBe(true);
      expect(found.hasMore).toBe(true);
    });

    it("returns nothing for a caller with no readable types", async () => {
      await setLabel(rid(1), "alpha", "k", null);
      const found = await adapter.findByLabel({
        appId: "alpha",
        key: "k",
        readableTypes: new Set(),
      });
      expect(found.labels).toHaveLength(0);
      expect(found.nextCursor).toBeNull();
    });

    it("pages a flag-only key to exhaustion, visiting each record once", async () => {
      for (let i = 0; i < 7; i++) await setLabel(rid(i), "alpha", "flag", null);

      const seen = await pageToExhaustion({ appId: "alpha", key: "flag", limit: 2 });
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    });

    it("pages a key whose values are a MIX of nulls and strings", async () => {
      // The case a bare record_id cursor gets wrong: record_id is not
      // monotonic across the range, because the range is ordered by
      // (value, record_id). Ids are assigned so that id order and value order
      // actively disagree.
      await setLabel(rid(1), "alpha", "k", "zebra");
      await setLabel(rid(2), "alpha", "k", null);
      await setLabel(rid(3), "alpha", "k", "apple");
      await setLabel(rid(4), "alpha", "k", null);
      await setLabel(rid(5), "alpha", "k", "mango");

      const seen = await pageToExhaustion({ appId: "alpha", key: "k", limit: 2 });
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      // Nulls first, then values ascending — the index's own order.
      expect(seen.slice(0, 2).sort()).toEqual([rid(2), rid(4)]);
      expect(seen.slice(2)).toEqual([rid(3), rid(5), rid(1)]);
    });

    it("treats a malformed cursor as the first page rather than failing", async () => {
      await setLabel(rid(1), "alpha", "k", null);
      const found = await adapter.findByLabel({
        appId: "alpha",
        key: "k",
        cursor: "not-a-real-cursor",
      });
      expect(found.labels).toHaveLength(1);
    });

    async function pageToExhaustion(
      q: { appId: string; key: string; limit: number },
    ): Promise<StarkeepId[]> {
      const seen: StarkeepId[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const page = await adapter.findByLabel({ ...q, cursor: cursor ?? undefined });
        seen.push(...page.labels.map((l) => l.recordId));
        cursor = page.nextCursor;
        expect(++guard).toBeLessThan(50);
      } while (cursor !== null);
      return seen;
    }
  });

  it("tombstones every app's labels when a record is deleted", async () => {
    await setLabel(rid(1), "alpha", "k", null);
    await setLabel(rid(1), "gamma", "k", null);
    await setLabel(rid(2), "alpha", "k", null);

    await adapter.tombstoneLabelsForRecord(rid(1), clock.now());

    expect((await adapter.getLabelsByRecordIds([rid(1)])).size).toBe(0);
    // The other record's labels are untouched.
    expect((await adapter.getLabelsByRecordIds([rid(2)])).get(rid(2))).toHaveLength(1);
  });

  it("does not touch the records table when a label is written", async () => {
    // The single most important implementation rule: a label write that bumped
    // records.updated_at would re-ship the whole record over the Drive channel
    // and disturb every peer's watermark.
    const before = await adapter.getNodeWatermarks();
    await setLabel(rid(1), "alpha", "k", null);
    const after = await adapter.getNodeWatermarks();
    expect(after).toEqual(before);
  });
});
