/**
 * Paging a sorted query.
 *
 * The property every case here asserts is the same one, and it is the property
 * the old cursor did not have: **paging to exhaustion returns exactly the
 * unpaged query, in exactly its order.** Nothing weaker is worth testing, because
 * the failure mode is not an error — it is a page that is merely the wrong rows,
 * which every caller happily renders.
 *
 * The old predicate was `id > cursor` compiled beside an `ORDER BY created_at
 * desc`, so page two dropped every record whose id happened to sort below the
 * cursor's, whatever its position in the requested order. A fixture of records
 * whose id order disagrees with their sort order is therefore the whole test:
 * with ids and sort keys correlated, the broken cursor passes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  type CreateDataRecordInput,
  type DataRecord,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { SqliteDatabaseAdapter } from "../src/adapter.js";
import { nodeSqliteDriver } from "../src/node-driver.js";
import type { Query } from "@starkeep/storage-adapter";

function baseInput(over: Partial<CreateDataRecordInput> = {}): CreateDataRecordInput {
  return {
    type: "image/jpeg",
    originAppId: "photos",
    contentHash: `sha256:${Math.random().toString(36).slice(2)}`,
    objectStorageKey: `shared/image/ab/${Math.random().toString(36).slice(2)}`,
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    ...over,
  };
}

describe("paging a sorted query", () => {
  let adapter: SqliteDatabaseAdapter;

  beforeEach(async () => {
    adapter = new SqliteDatabaseAdapter({ path: ":memory:", driver: nodeSqliteDriver });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
  });

  /** Read every page, and report the ids in the order they were handed over. */
  async function pageThrough(query: Query, pageSize: number): Promise<StarkeepId[]> {
    const seen: StarkeepId[] = [];
    let cursor: string | undefined;
    // Bounded so a cursor that fails to advance fails the test rather than
    // hanging it — a non-advancing cursor is one of the shapes this can break in.
    for (let page = 0; page < 100; page += 1) {
      const result = await adapter.query({
        ...query,
        limit: pageSize,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.records.map((r) => r.id));
      if (!result.hasMore || !result.nextCursor) return seen;
      cursor = result.nextCursor;
    }
    throw new Error("paging did not terminate");
  }

  async function unpaged(query: Query): Promise<StarkeepId[]> {
    const result = await adapter.query({ ...query, limit: 1000 });
    return result.records.map((r) => r.id);
  }

  /**
   * Records whose creation order deliberately disagrees with their id order.
   *
   * `createDataRecord` content-addresses the id, so writing them in a shuffled
   * sequence with distinct wall times is enough: neither the ids nor the
   * `created_at` values end up correlated with the other.
   */
  async function seed(count: number): Promise<DataRecord[]> {
    const written: DataRecord[] = [];
    for (let i = 0; i < count; i += 1) {
      const clock = createHLCClock({ nodeId: "test", wallClockFunction: () => 1000 + i });
      const record = createDataRecord(
        baseInput({ originalFilename: `photo-${String(i).padStart(3, "0")}.jpg` }),
        clock,
      );
      await adapter.put(record);
      written.push(record);
    }
    return written;
  }

  it("returns the whole set, in order, when paged by created_at descending", async () => {
    await seed(37);
    const query: Query = { sort: [{ field: "createdAt", direction: "desc" }] };

    const all = await unpaged(query);
    expect(all).toHaveLength(37);
    // The fixture has to be adversarial or this test proves nothing: with ids
    // ascending in step with the sort key, `id > cursor` is accidentally the
    // right predicate and the bug this file exists for passes unnoticed.
    expect(all).not.toEqual([...all].sort());
    expect(await pageThrough(query, 5)).toEqual(all);
  });

  it("returns the whole set when the page size divides the total exactly", async () => {
    // The boundary the `limit + 1` probe decides: a final page that is exactly
    // full must still report `hasMore: false` rather than hand out a cursor
    // pointing at nothing.
    await seed(20);
    const query: Query = { sort: [{ field: "createdAt", direction: "desc" }] };
    expect(await pageThrough(query, 5)).toEqual(await unpaged(query));
  });

  it("keeps the default id ordering and its bare-id cursor working", async () => {
    await seed(12);
    const query: Query = {};
    const ids = await pageThrough(query, 5);
    expect(ids).toEqual(await unpaged(query));
    // The legacy shape, deliberately preserved: for `id asc` the record id is
    // already a correct keyset, and cursors in flight against the cloud
    // data-server are of this shape.
    const first = await adapter.query({ limit: 5 });
    expect(first.nextCursor).toBe(first.records[4].id);
  });

  it("does not lose rows that tie on the sort key", async () => {
    // Every record shares one wall time, so `created_at` separates none of them
    // and the id tiebreaker is doing all the work. Without it a keyset
    // comparison on the key alone either repeats the whole tie group forever or
    // skips all but one of it.
    const clock = createHLCClock({ nodeId: "test", wallClockFunction: () => 5000 });
    for (let i = 0; i < 15; i += 1) {
      await adapter.put(
        createDataRecord(baseInput({ originalFilename: `tied-${i}.jpg` }), clock),
      );
    }
    const query: Query = { sort: [{ field: "createdAt", direction: "desc" }] };
    const ids = await pageThrough(query, 4);
    expect(ids).toEqual(await unpaged(query));
    expect(new Set(ids).size).toBe(15);
  });

  it("pages through a nullable sort key, null bucket included", async () => {
    const records = await seed(18);
    // Two thirds carry a capture time, one third does not — the state the
    // library is actually in while the EXIF backfill is still running.
    for (const [index, record] of records.entries()) {
      if (index % 3 === 0) continue;
      await adapter.putMetadata("image/jpeg", {
        recordId: record.id,
        captured_at: `2026-0${(index % 9) + 1}-01T12:00:00`,
      });
    }

    const query: Query = {
      sort: [
        { field: "capturedAt", direction: "desc" },
        { field: "createdAt", direction: "desc" },
      ],
    };
    const all = await unpaged(query);
    expect(all).toHaveLength(18);
    expect(await pageThrough(query, 4)).toEqual(all);
  });

  it("puts records with no capture time after every record that has one", async () => {
    const records = await seed(6);
    for (const [index, record] of records.entries()) {
      if (index >= 4) continue;
      await adapter.putMetadata("image/jpeg", {
        recordId: record.id,
        captured_at: `2026-01-0${index + 1}T12:00:00`,
      });
    }

    const page = await adapter.query({
      sort: [
        { field: "capturedAt", direction: "desc" },
        { field: "createdAt", direction: "desc" },
      ],
      limit: 10,
    });
    const withCapture = new Set(records.slice(0, 4).map((r) => r.id));
    // Nulls last, whatever the key's direction — normalized rather than left to
    // the backend, which is where SQLite and Postgres disagree.
    const positions = page.records.map((r) => withCapture.has(r.id));
    expect(positions).toEqual([true, true, true, true, false, false]);
  });

  it("ignores a cursor cut against a different ordering", async () => {
    await seed(10);
    const descending = await adapter.query({
      sort: [{ field: "createdAt", direction: "desc" }],
      limit: 3,
    });
    // Handed to the opposite order the token names a position that does not
    // exist there, so the caller gets the first page rather than a page from
    // the middle of an order it did not ask for.
    const reused = await adapter.query({
      sort: [{ field: "createdAt", direction: "asc" }],
      limit: 3,
      cursor: descending.nextCursor!,
    });
    const fresh = await adapter.query({
      sort: [{ field: "createdAt", direction: "asc" }],
      limit: 3,
    });
    expect(reused.records.map((r) => r.id)).toEqual(fresh.records.map((r) => r.id));
  });

  it("counts what the query matches without paging through it", async () => {
    await seed(23);
    expect(await adapter.countRecords({})).toBe(23);
    expect(await adapter.countRecords({ type: "image/jpeg" })).toBe(23);
    expect(await adapter.countRecords({ type: "video/mp4" })).toBe(0);
    // Paging inputs are ignored: a count of "the rest of the page" is not a
    // thing anybody wants.
    expect(await adapter.countRecords({ limit: 5 })).toBe(23);
  });

  it("counts the same set the label anti-join returns", async () => {
    const records = await seed(9);
    const clock = createHLCClock({ nodeId: "test", wallClockFunction: () => 9000 });
    await adapter.upsertLabels(
      records.slice(0, 4).map((record) => ({
        recordId: record.id,
        appId: "photos",
        key: "rendition",
        value: "image-thumb",
        recordType: record.type,
        hlc: clock.now(),
      })),
    );

    const query: Query = { excludeLabel: { appId: "photos", key: "rendition" } };
    expect(await adapter.countRecords(query)).toBe(5);
    expect((await adapter.query({ ...query, limit: 100 })).records).toHaveLength(5);
  });
});
