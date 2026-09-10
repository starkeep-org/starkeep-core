/**
 * The mock's `queryShared`, against the same parsed values the SQL adapters
 * compile.
 *
 * These cases are not a second copy of the conformance suite — that suite runs
 * against real planners and this store is a `Map`. What they establish is the
 * one property the mock exists for: it answers the questions the real backends
 * answer, in the shapes they answer them, so a suite that believes the mock is
 * not being told a different story about the grammar.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  type CreateDataRecordInput,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter } from "../src/mock/mock-database-adapter.js";
import type { AggregateQuery, RowQuery, WhereClause } from "../src/database/app-query-types.js";

const clock = createHLCClock({ nodeId: "test", wallClockFunction: () => 1000 });

function input(over: Partial<CreateDataRecordInput> = {}): CreateDataRecordInput {
  return {
    type: "image/jpeg",
    originAppId: "test",
    contentHash: `sha256:${Math.random().toString(36).slice(2)}`,
    objectStorageKey: `shared/image/ab/${Math.random().toString(36).slice(2)}`,
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    ...over,
  };
}

function rowQuery(over: Partial<RowQuery> = {}): RowQuery {
  return {
    mode: "rows",
    table: "record_image_metadata",
    select: null,
    where: [],
    order: [{ column: "record_id", direction: "asc", nulls: "last" }],
    limit: 100,
    pageToken: null,
    include: [],
    ...over,
  };
}

describe("MockDatabaseAdapter.queryShared", () => {
  let adapter: MockDatabaseAdapter;
  /** Three jpegs and one png, each with a metadata row. */
  const ids: string[] = [];

  beforeEach(async () => {
    adapter = new MockDatabaseAdapter();
    await adapter.init();
    ids.length = 0;
    const seed: Array<[string, number, string | null]> = [
      ["image/jpeg", 100, "2026-09-01T00:00:00.000Z"],
      ["image/jpeg", 200, null],
      ["image/jpeg", 300, "2026-09-09T00:00:00.000Z"],
      ["image/png", 999, "2026-09-11T00:00:00.000Z"],
    ];
    for (const [type, width, capturedAt] of seed) {
      const record = createDataRecord(input({ type }), clock);
      await adapter.put(record);
      await adapter.putMetadata(type, {
        recordId: record.id,
        width,
        captured_at: capturedAt,
      });
      ids.push(record.id);
    }
  });

  const jpegOnly: WhereClause[] = [
    { column: "record_type", predicate: { op: "in", values: ["image/jpeg"] } },
  ];

  it("applies the server's grant predicate inside the query", async () => {
    const result = await adapter.queryShared(
      { kind: "metadata", category: "image" },
      rowQuery(),
      { serverWhere: jpegOnly },
    );
    if (result.mode !== "rows") throw new Error("expected rows");
    expect(result.rows.map((r) => r["record_id"])).toEqual(ids.slice(0, 3).sort());
  });

  it("orders with the term's own null position and pages by keyset", async () => {
    const query = rowQuery({
      order: [
        { column: "captured_at", direction: "desc", nulls: "last" },
        { column: "record_id", direction: "asc", nulls: "last" },
      ],
      limit: 2,
    });
    const first = await adapter.queryShared({ kind: "metadata", category: "image" }, query, {
      serverWhere: jpegOnly,
    });
    if (first.mode !== "rows") throw new Error("expected rows");
    expect(first.rows.map((r) => r["captured_at"])).toEqual([
      "2026-09-09T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
    expect(first.truncated).toBe(true);

    const token = JSON.parse(
      Buffer.from(first.pageToken!, "base64url").toString("utf8"),
    ) as RowQuery["pageToken"];
    const second = await adapter.queryShared(
      { kind: "metadata", category: "image" },
      { ...query, pageToken: token },
      { serverWhere: jpegOnly },
    );
    if (second.mode !== "rows") throw new Error("expected rows");
    // The null bucket is last and is reached exactly once.
    expect(second.rows.map((r) => r["captured_at"])).toEqual([null]);
    expect(second.truncated).toBe(false);
  });

  it("aggregates over the gated rows only", async () => {
    const query: AggregateQuery = {
      mode: "aggregate",
      table: "record_image_metadata",
      groupBy: [],
      aggregates: [
        { name: "n", fn: "count", col: null, distinct: false },
        { name: "widest", fn: "max", col: "width", distinct: false },
      ],
      where: [],
      order: [],
      limit: 100,
    };
    const result = await adapter.queryShared(
      { kind: "metadata", category: "image" },
      query,
      { serverWhere: jpegOnly },
    );
    if (result.mode !== "aggregate") throw new Error("expected aggregate");
    // The png's 999 is in the same table and out of reach.
    expect(result.groups).toEqual([{ n: 3, widest: 300 }]);
  });

  it("excludes a tombstoned record from a records query", async () => {
    const record = createDataRecord(input(), clock);
    await adapter.put(record);
    await adapter.delete(record.id, clock.now());
    const result = await adapter.queryShared(
      { kind: "records" },
      rowQuery({ table: "records", order: [{ column: "id", direction: "asc", nulls: "last" }] }),
    );
    if (result.mode !== "rows") throw new Error("expected rows");
    expect(result.rows.map((r) => r["id"])).not.toContain(record.id);
  });

  it("refuses a category with no metadata table", async () => {
    await expect(
      adapter.queryShared({ kind: "metadata", category: "other" }, rowQuery()),
    ).rejects.toThrow(/no metadata table/);
  });
});
