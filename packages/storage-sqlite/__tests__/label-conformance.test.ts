/**
 * The label contract, run against every adapter that can be run offline.
 *
 * Label SQL is built once in `@starkeep/storage-adapter` and shared by both SQL
 * backends, and the in-memory adapter borrows the same order and cursor
 * comparators — but each still implements `DatabaseAdapter` in its own terms,
 * and the SDK's tests run entirely against the mock. So the mock agreeing with
 * a real store is load-bearing: if it ordered the reverse scan differently, or
 * revived a tombstone on upsert, every SDK test would still pass and nothing
 * would notice until a cloud run.
 *
 * This file lives in storage-sqlite because it is the package with both
 * implementations on its dependency path — storage-adapter must not depend on a
 * concrete backend. DSQL cannot join in offline; its SQL shape is pinned in
 * `storage-adapter/__tests__/label-queries.test.ts` and its behaviour by the
 * AWS e2e journey.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createHLCClock,
  createStarkeepId,
  type HLCClock,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, type DatabaseAdapter } from "@starkeep/storage-adapter";
import { SqliteDatabaseAdapter } from "../src/adapter.js";

interface Backend {
  name: string;
  create: () => Promise<DatabaseAdapter>;
  dispose: (adapter: DatabaseAdapter) => Promise<void>;
}

const backends: Backend[] = [
  {
    name: "MockDatabaseAdapter",
    create: async () => {
      const adapter = new MockDatabaseAdapter();
      await adapter.init();
      return adapter;
    },
    dispose: (adapter) => adapter.close(),
  },
  {
    name: "SqliteDatabaseAdapter",
    create: async () => {
      const adapter = new SqliteDatabaseAdapter({ path: ":memory:" });
      await adapter.init();
      return adapter;
    },
    dispose: (adapter) => adapter.close(),
  },
];

describe.each(backends)("label contract — $name", (backend) => {
  let adapter: DatabaseAdapter;
  let clock: HLCClock;
  let tick: number;

  const rid = (n: number) =>
    createStarkeepId(`01J0000000000000000000${String(n).padStart(4, "0")}`);

  beforeEach(async () => {
    adapter = await backend.create();
    tick = 0;
    clock = createHLCClock({ nodeId: "nodeA", wallClockFunction: () => 1000 + tick++ });
  });

  afterEach(async () => {
    await backend.dispose(adapter);
  });

  async function setLabel(
    recordId: StarkeepId,
    appId: string,
    key: string,
    value = "",
    recordType = "image/jpeg",
  ) {
    await adapter.upsertLabels([
      { recordId, appId, key, value, recordType, hlc: clock.now() },
    ]);
  }

  async function pageToExhaustion(q: {
    appId: string;
    key: string;
    value?: string;
    limit: number;
  }): Promise<StarkeepId[]> {
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

  // ---- writing -----------------------------------------------------------

  it("round-trips a flag and a valued label, denormalizing the record type", async () => {
    await setLabel(rid(1), "alpha", "needs-review");
    await setLabel(rid(1), "alpha", "quality", "high");

    const labels = (await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))!;
    expect(labels).toHaveLength(2);
    // A bare flag is the empty string. There is no null anywhere in the model.
    expect(labels.find((l) => l.key === "needs-review")!.value).toBe("");
    expect(labels.find((l) => l.key === "quality")!.value).toBe("high");
    expect(labels.every((l) => l.recordType === "image/jpeg")).toBe(true);
  });

  it("lets two apps hold contradictory opinions about one record", async () => {
    await setLabel(rid(1), "alpha", "quality", "high");
    await setLabel(rid(1), "gamma", "quality", "low");

    const labels = (await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))!;
    expect(new Set(labels.map((l) => `${l.appId}=${l.value}`))).toEqual(
      new Set(["alpha=high", "gamma=low"]),
    );
  });

  it("upserts by the FOUR-column primary key, so a second value is a second row", async () => {
    // The change the widened primary key exists for. On the old three-column
    // key this overwrote; now it accumulates, and that difference is the one
    // thing every writer has to know.
    await setLabel(rid(1), "alpha", "face", "Alice");
    await setLabel(rid(1), "alpha", "face", "Bob");

    const labels = (await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))!;
    expect(labels.map((l) => l.value).sort()).toEqual(["Alice", "Bob"]);
  });

  it("upserts rather than duplicating when the whole primary key repeats", async () => {
    await setLabel(rid(1), "alpha", "quality", "high", "image/jpeg");
    await setLabel(rid(1), "alpha", "quality", "high", "image/png");

    const labels = (await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))!;
    expect(labels).toHaveLength(1);
    expect(labels[0].recordType).toBe("image/png");
  });

  it("accepts the same primary key twice in ONE batch, last write winning", async () => {
    // Postgres rejects a multi-row ON CONFLICT DO UPDATE that touches a row
    // twice (21000) where SQLite silently keeps the last, so an undeduped
    // batch is one that works offline and 500s in the cloud. The dedupe lives
    // in the shared query builder precisely so no adapter can differ here.
    const hlc = clock.now();
    await adapter.upsertLabels([
      { recordId: rid(1), appId: "alpha", key: "quality", value: "high", recordType: "image/jpeg", hlc },
      { recordId: rid(1), appId: "alpha", key: "quality", value: "high", recordType: "image/png", hlc },
      { recordId: rid(2), appId: "alpha", key: "quality", value: "mid", recordType: "image/jpeg", hlc },
    ]);

    const one = (await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))!;
    expect(one).toHaveLength(1);
    expect(one[0].recordType).toBe("image/png");
    expect((await adapter.getLabelsByRecordIds([rid(2)])).get(rid(2))![0].value).toBe("mid");
  });

  it("does NOT collapse two values of one key inside a single batch", async () => {
    // The same dedupe, from the other side: keyed on three columns it would
    // silently drop one of these, turning a set-valued write into a
    // single-valued one with no error at all.
    const hlc = clock.now();
    await adapter.upsertLabels([
      { recordId: rid(1), appId: "alpha", key: "face", value: "Alice", recordType: "image/jpeg", hlc },
      { recordId: rid(1), appId: "alpha", key: "face", value: "Bob", recordType: "image/jpeg", hlc },
    ]);
    const labels = (await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))!;
    expect(labels.map((l) => l.value).sort()).toEqual(["Alice", "Bob"]);
  });

  it("writes a whole batch across several records and apps", async () => {
    const hlc = clock.now();
    await adapter.upsertLabels([
      { recordId: rid(1), appId: "alpha", key: "k", value: "", recordType: "image/jpeg", hlc },
      { recordId: rid(2), appId: "alpha", key: "k", value: "", recordType: "image/jpeg", hlc },
      { recordId: rid(2), appId: "gamma", key: "k", value: "v", recordType: "image/jpeg", hlc },
    ]);
    const byId = await adapter.getLabelsByRecordIds([rid(1), rid(2)]);
    expect(byId.get(rid(1))).toHaveLength(1);
    expect(byId.get(rid(2))).toHaveLength(2);
  });

  it("no-ops on an empty batch", async () => {
    await expect(adapter.upsertLabels([])).resolves.toBeUndefined();
    await expect(adapter.retractLabels([])).resolves.toBeUndefined();
    await expect(adapter.replaceLabelValues([])).resolves.toBeUndefined();
    expect((await adapter.getLabelsByRecordIds([])).size).toBe(0);
  });

  // ---- the set-valued write ----------------------------------------------

  async function replaceValues(recordId: StarkeepId, key: string, values: string[]) {
    await adapter.replaceLabelValues([
      { recordId, appId: "alpha", key, values, recordType: "image/jpeg", hlc: clock.now() },
    ]);
  }

  const valuesOn = async (recordId: StarkeepId, key: string) =>
    ((await adapter.getLabelsByRecordIds([recordId])).get(recordId) ?? [])
      .filter((l) => l.key === key)
      .map((l) => l.value)
      .sort();

  it("replaceLabelValues makes the key hold exactly what it was given", async () => {
    await setLabel(rid(1), "alpha", "face", "Alice");
    await setLabel(rid(1), "alpha", "face", "Bob");

    await replaceValues(rid(1), "face", ["Alice", "Carol"]);
    // Alice kept, Bob tombstoned, Carol added — the diff a caller would
    // otherwise compute itself, non-atomically, from a read it had to do first.
    expect(await valuesOn(rid(1), "face")).toEqual(["Alice", "Carol"]);
  });

  it("replaceLabelValues leaves other keys and other apps alone", async () => {
    await setLabel(rid(1), "alpha", "face", "Alice");
    await setLabel(rid(1), "alpha", "quality", "high");
    await setLabel(rid(1), "gamma", "face", "Bob");

    await replaceValues(rid(1), "face", ["Carol"]);

    const labels = (await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))!;
    expect(labels.filter((l) => l.appId === "alpha" && l.key === "face").map((l) => l.value))
      .toEqual(["Carol"]);
    // Scoped by (record, app, key): another key of the same app, and the same
    // key of another app, are untouched.
    expect(labels.find((l) => l.key === "quality")!.value).toBe("high");
    expect(labels.find((l) => l.appId === "gamma")!.value).toBe("Bob");
  });

  it("replaceLabelValues with an empty set clears the key", async () => {
    await setLabel(rid(1), "alpha", "face", "Alice");
    await setLabel(rid(1), "alpha", "face", "Bob");

    // The `not in ()` an empty list would otherwise compile to is invalid SQL,
    // so this is the case a naive implementation throws on.
    await replaceValues(rid(1), "face", []);
    expect(await valuesOn(rid(1), "face")).toEqual([]);
  });

  it("replaceLabelValues revives a value it retracted earlier", async () => {
    await replaceValues(rid(1), "face", ["Alice"]);
    await replaceValues(rid(1), "face", ["Bob"]);
    await replaceValues(rid(1), "face", ["Alice"]);
    // Without the upsert clearing deleted_at, Alice's row comes back as a
    // tombstone and stays invisible forever.
    expect(await valuesOn(rid(1), "face")).toEqual(["Alice"]);
  });

  it("replaceLabelValues is how a single-valued key is updated", async () => {
    // The reason this method exists: a plain upsert of face-count=4 leaves
    // face-count=3 beside it, and the key then reads back as two answers with
    // nothing to say which is current.
    await setLabel(rid(1), "alpha", "face-count", "3");
    await replaceValues(rid(1), "face-count", ["4"]);
    expect(await valuesOn(rid(1), "face-count")).toEqual(["4"]);
  });

  // ---- retraction --------------------------------------------------------

  it("retracts as a tombstone, invisible to readers but still readable by the sync path", async () => {
    await setLabel(rid(1), "alpha", "needs-review");
    await adapter.retractLabels([
      { recordId: rid(1), appId: "alpha", key: "needs-review", hlc: clock.now() },
    ]);

    expect((await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))).toBeUndefined();
    expect((await adapter.findByLabel({ appId: "alpha", key: "needs-review" })).labels).toHaveLength(0);
    // getLabel returns tombstones on purpose: a tombstone is exactly what a
    // later arrival has to be LWW-compared against.
    const row = await adapter.getLabel(rid(1), "alpha", "needs-review", "");
    expect(row?.deletedAt).not.toBeNull();
  });

  it("revives a retracted label when it is set again", async () => {
    await setLabel(rid(1), "alpha", "needs-review");
    await adapter.retractLabels([
      { recordId: rid(1), appId: "alpha", key: "needs-review", hlc: clock.now() },
    ]);
    await setLabel(rid(1), "alpha", "needs-review");

    const found = await adapter.findByLabel({ appId: "alpha", key: "needs-review" });
    expect(found.labels.map((l) => l.recordId)).toEqual([rid(1)]);
    expect(
      (await adapter.getLabel(rid(1), "alpha", "needs-review", ""))!.deletedAt,
    ).toBeNull();
  });

  it("retracting a row that was never written creates nothing", async () => {
    await adapter.retractLabels([
      { recordId: rid(1), appId: "alpha", key: "never-set", hlc: clock.now() },
    ]);
    expect(await adapter.getLabel(rid(1), "alpha", "never-set", "")).toBeNull();
  });

  it("retraction is scoped by primary key, so it cannot reach another app's row", async () => {
    await setLabel(rid(1), "alpha", "k");
    await setLabel(rid(1), "gamma", "k");
    await adapter.retractLabels([
      { recordId: rid(1), appId: "alpha", key: "k", hlc: clock.now() },
    ]);

    const live = (await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))!;
    expect(live.map((l) => l.appId)).toEqual(["gamma"]);
  });

  it("retracting without a value takes back every value of the key", async () => {
    // The one retraction shape that quietly does nothing if it pins `value`
    // anyway — an app with three names on a photo taking the key back.
    await setLabel(rid(1), "alpha", "face", "Alice");
    await setLabel(rid(1), "alpha", "face", "Bob");
    await setLabel(rid(1), "alpha", "quality", "high");

    await adapter.retractLabels([
      { recordId: rid(1), appId: "alpha", key: "face", hlc: clock.now() },
    ]);

    const live = (await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))!;
    expect(live.map((l) => l.key)).toEqual(["quality"]);
  });

  it("retracting with a value takes back only that one", async () => {
    await setLabel(rid(1), "alpha", "face", "Alice");
    await setLabel(rid(1), "alpha", "face", "Bob");

    await adapter.retractLabels([
      { recordId: rid(1), appId: "alpha", key: "face", value: "Bob", hlc: clock.now() },
    ]);

    const live = (await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))!;
    expect(live.map((l) => l.value)).toEqual(["Alice"]);
  });

  it('retracting value "" reaches the bare flag and nothing else', async () => {
    // `""` and "omitted" are different requests, and the difference is exactly
    // the flag-vs-everything one.
    await setLabel(rid(1), "alpha", "face");
    await setLabel(rid(1), "alpha", "face", "Alice");

    await adapter.retractLabels([
      { recordId: rid(1), appId: "alpha", key: "face", value: "", hlc: clock.now() },
    ]);

    const live = (await adapter.getLabelsByRecordIds([rid(1)])).get(rid(1))!;
    expect(live.map((l) => l.value)).toEqual(["Alice"]);
  });

  // ---- forward reads -----------------------------------------------------

  it("omits ids with no labels from the map rather than mapping them to []", async () => {
    await setLabel(rid(1), "alpha", "k");
    const byId = await adapter.getLabelsByRecordIds([rid(1), rid(2)]);
    expect(byId.has(rid(2))).toBe(false);
  });

  // ---- the reverse query -------------------------------------------------

  it("presence filter matches any value including a bare flag", async () => {
    await setLabel(rid(1), "alpha", "k");
    await setLabel(rid(2), "alpha", "k", "v");
    await setLabel(rid(3), "alpha", "other", "v");

    const found = await adapter.findByLabel({ appId: "alpha", key: "k" });
    expect(found.labels.map((l) => l.recordId).sort()).toEqual([rid(1), rid(2)]);
  });

  it('value "" is a filter for bare flags, not the absence of a filter', async () => {
    // Read as "no filter" this returns a superset — which looks like it works,
    // and is the failure mode the query parsers have to keep apart too.
    await setLabel(rid(1), "alpha", "k");
    await setLabel(rid(2), "alpha", "k", "v");

    const found = await adapter.findByLabel({ appId: "alpha", key: "k", value: "" });
    expect(found.labels.map((l) => l.recordId)).toEqual([rid(1)]);
  });

  it("value filter is an exact match", async () => {
    await setLabel(rid(1), "alpha", "quality", "high");
    await setLabel(rid(2), "alpha", "quality", "higher");
    await setLabel(rid(3), "alpha", "quality", "low");

    const found = await adapter.findByLabel({ appId: "alpha", key: "quality", value: "high" });
    expect(found.labels.map((l) => l.recordId)).toEqual([rid(1)]);
  });

  it("finds every record carrying one value of a set-valued key", async () => {
    // The question the whole change exists to answer: "which photos contain
    // Alice?", asked by an app that never calls the labeller. Packed into one
    // row as "Alice,Bob" this needs a substring scan, which no index serves and
    // which matches "Alicent" besides.
    await adapter.upsertLabels(
      [
        [rid(1), "Alice"],
        [rid(1), "Bob"],
        [rid(2), "Alice"],
        [rid(3), "Alicent"],
      ].map(([recordId, value]) => ({
        recordId: recordId as StarkeepId,
        appId: "alpha",
        key: "face",
        value: value as string,
        recordType: "image/jpeg",
        hlc: clock.now(),
      })),
    );

    const found = await adapter.findByLabel({ appId: "alpha", key: "face", value: "Alice" });
    expect(found.labels.map((l) => l.recordId).sort()).toEqual([rid(1), rid(2)]);
  });

  it("does not leak another app's namespace", async () => {
    await setLabel(rid(1), "gamma", "k");
    expect((await adapter.findByLabel({ appId: "alpha", key: "k" })).labels).toHaveLength(0);
  });

  it("filters by the caller's readable types, and the page still comes back full", async () => {
    for (let i = 0; i < 12; i++) {
      await setLabel(rid(i), "alpha", "k", "", i % 2 === 0 ? "image/jpeg" : "image/png");
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
    await setLabel(rid(1), "alpha", "k");
    const found = await adapter.findByLabel({
      appId: "alpha",
      key: "k",
      readableTypes: new Set(),
    });
    expect(found.labels).toHaveLength(0);
    expect(found.nextCursor).toBeNull();
    expect(found.hasMore).toBe(false);
  });

  it("pages a flag-only key to exhaustion, visiting each record once", async () => {
    for (let i = 0; i < 7; i++) await setLabel(rid(i), "alpha", "flag");
    const seen = await pageToExhaustion({ appId: "alpha", key: "flag", limit: 2 });
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("pages a key whose values are a MIX of flags and strings", async () => {
    // The case a bare record_id cursor gets wrong: the range is ordered by
    // (value, record_id), so record_id is not monotonic across it. Ids are
    // assigned so id order and value order actively disagree.
    await setLabel(rid(1), "alpha", "k", "zebra");
    await setLabel(rid(2), "alpha", "k");
    await setLabel(rid(3), "alpha", "k", "apple");
    await setLabel(rid(4), "alpha", "k");
    await setLabel(rid(5), "alpha", "k", "mango");

    const seen = await pageToExhaustion({ appId: "alpha", key: "k", limit: 2 });
    expect(seen).toHaveLength(5);
    // Empty first, then values ascending — the index's own order, which both
    // backends now present identically without either having to spell it out,
    // because "" sorts before every other string on both.
    expect(seen.slice(0, 2).sort()).toEqual([rid(2), rid(4)]);
    expect(seen.slice(2)).toEqual([rid(3), rid(5), rid(1)]);
  });

  it("pages several values of ONE key on one record without skipping any", async () => {
    // With `record_id` pinned by the data and only `value` moving, this is the
    // page shape the set-valued key introduced, and the one a cursor that
    // ignored `value` would collapse to a single row.
    const names = ["ada", "bob", "cy", "dee", "eve"];
    await adapter.upsertLabels(
      names.map((value) => ({
        recordId: rid(1),
        appId: "alpha",
        key: "face",
        value,
        recordType: "image/jpeg",
        hlc: clock.now(),
      })),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = await adapter.findByLabel({
        appId: "alpha",
        key: "face",
        limit: 2,
        cursor: cursor ?? undefined,
      });
      seen.push(...page.labels.map((l) => l.value));
      cursor = page.nextCursor;
      expect(++guard).toBeLessThan(50);
    } while (cursor !== null);

    expect(seen).toEqual(names);
  });

  it("pages with a pinned value, where the order collapses to record id", async () => {
    for (let i = 0; i < 5; i++) await setLabel(rid(i), "alpha", "quality", "high");
    await setLabel(rid(9), "alpha", "quality", "low");

    const seen = await pageToExhaustion({
      appId: "alpha",
      key: "quality",
      value: "high",
      limit: 2,
    });
    expect(seen).toEqual([rid(0), rid(1), rid(2), rid(3), rid(4)]);
  });

  it("reports hasMore and a null nextCursor on the last page", async () => {
    for (let i = 0; i < 3; i++) await setLabel(rid(i), "alpha", "k");
    const first = await adapter.findByLabel({ appId: "alpha", key: "k", limit: 3 });
    expect(first.hasMore).toBe(false);
    expect(first.nextCursor).toBeNull();
  });

  it("treats a malformed cursor as the first page rather than failing", async () => {
    await setLabel(rid(1), "alpha", "k");
    const found = await adapter.findByLabel({
      appId: "alpha",
      key: "k",
      cursor: "not-a-real-cursor",
    });
    expect(found.labels).toHaveLength(1);
  });

  // ---- the sync-facing surface -------------------------------------------

  it("putLabel writes a snapshot verbatim, tombstone included", async () => {
    await setLabel(rid(1), "alpha", "k", "v");
    const live = (await adapter.getLabel(rid(1), "alpha", "k", "v"))!;

    // An inbound retraction from a peer: same row, later HLC, deletedAt set.
    const retractedAt = clock.now();
    await adapter.putLabel({ ...live, updatedAt: retractedAt, deletedAt: retractedAt });

    // Stays retracted — using the local-write upsert here would clear
    // deleted_at and resurrect it.
    expect((await adapter.getLabel(rid(1), "alpha", "k", "v"))!.deletedAt).not.toBeNull();
    expect((await adapter.getLabelsByRecordIds([rid(1)])).size).toBe(0);
  });

  it("putLabel preserves the incoming createdAt rather than restamping it", async () => {
    const created = clock.now();
    const updated = clock.now();
    await adapter.putLabel({
      recordId: rid(1),
      appId: "alpha",
      key: "k",
      value: "v",
      recordType: "image/jpeg",
      createdAt: created,
      updatedAt: updated,
      nodeId: updated.nodeId,
      deletedAt: null,
    });
    const stored = (await adapter.getLabel(rid(1), "alpha", "k", "v"))!;
    expect(stored.createdAt).toEqual(created);
    expect(stored.updatedAt).toEqual(updated);
  });

  it("getLabel returns null for a row that does not exist", async () => {
    expect(await adapter.getLabel(rid(1), "alpha", "nope", "")).toBeNull();
  });

  it("getLabel reads one value of a key, not whichever sibling comes first", async () => {
    // Each value has its own LWW domain, so the sync apply path compares an
    // incoming row against *its* row. Looking up without `value` would compare
    // Bob against Alice and drop Bob as stale.
    await setLabel(rid(1), "alpha", "face", "Alice");
    await setLabel(rid(1), "alpha", "face", "Bob");

    expect((await adapter.getLabel(rid(1), "alpha", "face", "Bob"))!.value).toBe("Bob");
    expect(await adapter.getLabel(rid(1), "alpha", "face", "Carol")).toBeNull();
  });

  it("queryLabels scans every row including tombstones, in primary-key order", async () => {
    await setLabel(rid(2), "alpha", "k");
    await setLabel(rid(1), "gamma", "k");
    await setLabel(rid(1), "alpha", "k");
    await adapter.retractLabels([
      { recordId: rid(2), appId: "alpha", key: "k", hlc: clock.now() },
    ]);

    const page = await adapter.queryLabels({});
    expect(page.labels.map((l) => `${l.recordId}/${l.appId}`)).toEqual([
      `${rid(1)}/alpha`,
      `${rid(1)}/gamma`,
      `${rid(2)}/alpha`,
    ]);
    // The tombstone is in the scan: the retraction itself has to sync.
    expect(page.labels.find((l) => l.recordId === rid(2))!.deletedAt).not.toBeNull();
  });

  it("queryLabels pages to exhaustion without skipping or repeating", async () => {
    for (let i = 0; i < 7; i++) await setLabel(rid(i), "alpha", "k");
    await setLabel(rid(0), "gamma", "k");
    // Several values of one key, so the page boundary can land inside a
    // (record, app, key) group — where a cursor without `value` skips every
    // sibling after the first, losing rows from the sync stream silently.
    for (const value of ["ada", "bob", "cy", "dee"]) {
      await setLabel(rid(0), "alpha", "face", value);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = await adapter.queryLabels({ limit: 3, cursor: cursor ?? undefined });
      seen.push(...page.labels.map((l) => `${l.recordId}/${l.appId}/${l.key}=${l.value}`));
      cursor = page.nextCursor;
      expect(++guard).toBeLessThan(50);
    } while (cursor !== null);

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it("getLabelNodeWatermarks reports the max per node, tombstones included", async () => {
    const other = createHLCClock({ nodeId: "nodeB", wallClockFunction: () => 5000 });
    await setLabel(rid(1), "alpha", "k");
    await adapter.upsertLabels([
      {
        recordId: rid(2),
        appId: "alpha",
        key: "k",
        value: "",
        recordType: "image/jpeg",
        hlc: other.now(),
      },
    ]);
    const last = clock.now();
    await adapter.retractLabels([
      { recordId: rid(1), appId: "alpha", key: "k", hlc: last },
    ]);

    const watermarks = await adapter.getLabelNodeWatermarks();
    expect(Object.keys(watermarks).sort()).toEqual(["nodeA", "nodeB"]);
    // The retraction is the latest thing nodeA did, and it counts.
    expect(watermarks["nodeA"]).toEqual(last);
  });

  it("tombstones every app's labels when a record is deleted, and only that record's", async () => {
    await setLabel(rid(1), "alpha", "k");
    await setLabel(rid(1), "gamma", "k");
    await setLabel(rid(2), "alpha", "k");

    await adapter.tombstoneLabelsForRecord(rid(1), clock.now());

    expect((await adapter.getLabelsByRecordIds([rid(1)])).size).toBe(0);
    expect((await adapter.getLabelsByRecordIds([rid(2)])).get(rid(2))).toHaveLength(1);
  });

  it("does not touch the records table when a label is written", async () => {
    // The single most important implementation rule: a label write that bumped
    // records.updated_at would re-ship the whole record over the Drive channel
    // and disturb every peer's watermark.
    const before = await adapter.getNodeWatermarks();
    await setLabel(rid(1), "alpha", "k");
    expect(await adapter.getNodeWatermarks()).toEqual(before);
  });

  it("does not restamp labels already tombstoned when the record is deleted", async () => {
    await setLabel(rid(1), "alpha", "k");
    const retractedAt = clock.now();
    await adapter.retractLabels([
      { recordId: rid(1), appId: "alpha", key: "k", hlc: retractedAt },
    ]);

    await adapter.tombstoneLabelsForRecord(rid(1), clock.now());

    // Re-stamping would ship a pointless later HLC to every peer for a row
    // that already said the same thing.
    expect((await adapter.getLabel(rid(1), "alpha", "k", ""))!.deletedAt).toEqual(retractedAt);
  });
});
