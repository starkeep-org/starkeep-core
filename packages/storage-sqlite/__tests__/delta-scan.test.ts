/**
 * `querySince` / `queryLabelsSince` — the delta scan that replaced
 * read-everything-then-filter-in-JS on the sync outbound path.
 *
 * The central assertion here is **equivalence with the shape it replaced**:
 * for any watermark map, the delta scan must return exactly the rows the old
 * `query()`-then-filter would have. That is not a stylistic check. The
 * coverage watermark compresses an unbounded set of rows into one timestamp per
 * author, and that compression is only truthful if the rows shipped form an
 * unbroken run from the watermark. A delta scan that skips one row lets the
 * peer report coverage over it, after which no round ever offers it again — a
 * silent, permanent loss of exactly the kind the watermark exists to prevent.
 * So the reference implementation stays in the test file forever.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  compareHLC,
  createDataRecord,
  type CreateDataRecordInput,
  type DataRecord,
  type HLCClock,
  type HLCTimestamp,
} from "@starkeep/protocol-primitives";
import { SqliteDatabaseAdapter } from "../src/adapter.js";
import { nodeSqliteDriver } from "../src/node-driver.js";

function hlc(nodeId: string, wallTime: number, counter = 0): HLCTimestamp {
  return { wallTime, counter, nodeId };
}

/** A clock pinned to one timestamp — `createDataRecord` wants a clock, not an HLC. */
function at(nodeId: string, wallTime: number, counter = 0): HLCClock {
  const stamp = hlc(nodeId, wallTime, counter);
  return { now: () => stamp, receive: () => stamp, nodeId } as unknown as HLCClock;
}

function baseInput(over: Partial<CreateDataRecordInput> = {}): CreateDataRecordInput {
  return {
    type: "@test/photo",
    originAppId: "test",
    contentHash: `sha256:${Math.random().toString(36).slice(2)}`,
    objectStorageKey: `shared/@test/photo/ab/${Math.random().toString(36).slice(2)}`,
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    ...over,
  };
}

/**
 * What the outbound scan used to do: read the whole table in primary-key order
 * and drop what the peer already has. Kept as the oracle.
 */
async function referenceScan(
  adapter: SqliteDatabaseAdapter,
  peerWatermarks: Record<string, HLCTimestamp>,
): Promise<DataRecord[]> {
  const out: DataRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await adapter.query({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const r of page.records) {
      const peer = peerWatermarks[r.updatedAt.nodeId];
      if (!peer || compareHLC(r.updatedAt, peer) > 0) out.push(r);
    }
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

const idsOf = (records: { id: string }[]) => records.map((r) => r.id).sort();

describe("querySince — delta scan", () => {
  let adapter: SqliteDatabaseAdapter;

  beforeEach(async () => {
    adapter = new SqliteDatabaseAdapter({ path: ":memory:", driver: nodeSqliteDriver });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
  });

  /** Three authors, ten writes each, interleaved in wall time. */
  async function seedThreeAuthors(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
      for (const nodeId of ["node-a", "node-b", "node-c"]) {
        const record = createDataRecord(
          baseInput({ originalFilename: `${nodeId}-${i}.jpg` }),
          at(nodeId, 1000 + i * 10),
        );
        await adapter.put(record);
      }
    }
  }

  it("returns exactly what read-everything-then-filter returns, for every watermark shape", async () => {
    await seedThreeAuthors();

    const shapes: Record<string, HLCTimestamp>[] = [
      // First sync: the peer has nothing.
      {},
      // Fully caught up on one author, untouched on the others.
      { "node-a": hlc("node-a", 1090) },
      // Partway through every author, at different positions — the case a
      // single global floor cannot express.
      {
        "node-a": hlc("node-a", 1030),
        "node-b": hlc("node-b", 1060),
        "node-c": hlc("node-c", 1000),
      },
      // Caught up everywhere: steady state, nothing owed.
      {
        "node-a": hlc("node-a", 1090),
        "node-b": hlc("node-b", 1090),
        "node-c": hlc("node-c", 1090),
      },
      // A watermark naming an author with no rows here must not disturb the rest.
      { "node-d": hlc("node-d", 9999) },
    ];

    for (const peerWatermarks of shapes) {
      const expected = await referenceScan(adapter, peerWatermarks);
      const actual = await adapter.querySince(peerWatermarks, 1000);
      expect(idsOf(actual.rows), JSON.stringify(peerWatermarks)).toEqual(
        idsOf(expected),
      );
      expect(actual.hasMore).toBe(false);
    }
  });

  it("steady state returns nothing", async () => {
    await seedThreeAuthors();
    const caughtUp = await adapter.getNodeWatermarks();
    const page = await adapter.querySince(caughtUp, 1000);
    expect(page.rows).toHaveLength(0);
    expect(page.hasMore).toBe(false);
  });

  it("a row exactly at the watermark is not re-sent; the next one is", async () => {
    // The boundary is exclusive: `updated_at > watermark`. An inclusive bound
    // would re-ship one row per author forever.
    await adapter.put(createDataRecord(baseInput(), at("node-a", 1000)));
    await adapter.put(createDataRecord(baseInput(), at("node-a", 2000)));

    const page = await adapter.querySince({ "node-a": hlc("node-a", 1000) }, 10);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.updatedAt.wallTime).toBe(2000);
  });

  it("orders ascending within an author, so a truncated page is a prefix", async () => {
    // The contiguous-prefix rule depends on this: cutting the page short must
    // leave the peer with an unbroken run, never a hole.
    for (const wallTime of [5000, 1000, 3000, 2000, 4000]) {
      await adapter.put(createDataRecord(baseInput(), at("node-a", wallTime)));
    }
    const page = await adapter.querySince({}, 3);
    expect(page.rows.map((r) => r.updatedAt.wallTime)).toEqual([1000, 2000, 3000]);
    expect(page.hasMore).toBe(true);
  });

  it("splits the budget across authors instead of spending it in order", async () => {
    await seedThreeAuthors();
    // 30 rows owed across three authors, room for 6. Spending the budget in
    // author order would return six rows of node-a and nothing else, which is
    // how an author that cannot drain starves every author behind it. Each
    // author gets its own slice instead.
    const page = await adapter.querySince({}, 6);
    const perAuthor = new Map<string, number>();
    for (const r of page.rows) {
      perAuthor.set(r.updatedAt.nodeId, (perAuthor.get(r.updatedAt.nodeId) ?? 0) + 1);
    }
    expect([...perAuthor.keys()].sort()).toEqual(["node-a", "node-b", "node-c"]);
    expect([...perAuthor.values()]).toEqual([2, 2, 2]);
    expect(page.hasMore).toBe(true);
  });

  it("marks each truncated author with the last row it actually returned", async () => {
    await seedThreeAuthors();
    // The marks are what `round-cut.ts` turns into a ceiling. Getting them
    // wrong by even one row is the difference between a contiguous prefix and
    // a permanent hole, so they are pinned to the exact boundary row.
    const page = await adapter.querySince({}, 6);
    expect(Object.keys(page.truncated).sort()).toEqual(["node-a", "node-b", "node-c"]);
    for (const nodeId of ["node-a", "node-b", "node-c"]) {
      const last = page.rows.filter((r) => r.updatedAt.nodeId === nodeId).at(-1)!;
      expect(page.truncated[nodeId]).toEqual(last.updatedAt);
    }
  });

  it("marks nothing when every author was enumerated to the end", async () => {
    await seedThreeAuthors();
    const page = await adapter.querySince({}, 1000);
    expect(page.truncated).toEqual({});
    expect(page.hasMore).toBe(false);
  });

  it("treats a zero budget as \"nothing is safe\", not as \"nothing is owed\"", async () => {
    // A `null` mark blocks shipping for that author entirely. Reporting `{}`
    // here would claim complete enumeration of a table nobody read.
    await seedThreeAuthors();
    const page = await adapter.querySince({}, 0);
    expect(page.rows).toHaveLength(0);
    expect(page.hasMore).toBe(true);
    expect(page.truncated).toEqual({
      "node-a": null,
      "node-b": null,
      "node-c": null,
    });
  });

  it("includes tombstones — a deletion has to reach the peer too", async () => {
    const record = createDataRecord(baseInput(), at("node-a", 1000));
    await adapter.put(record);
    await adapter.delete(record.id, hlc("node-a", 2000));

    const page = await adapter.querySince({ "node-a": hlc("node-a", 1500) }, 10);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.deletedAt).not.toBeNull();
  });

  it("survives an author whose id sorts oddly", async () => {
    // nodeIds are opaque strings; the per-author loop sorts them only for
    // determinism and must not assume any format.
    for (const nodeId of ["", "ZZZ", "aaa", "0", "node-with-dashes"]) {
      await adapter.put(createDataRecord(baseInput(), at(nodeId, 1000)));
    }
    const page = await adapter.querySince({}, 100);
    expect(page.rows).toHaveLength(5);
  });
});
