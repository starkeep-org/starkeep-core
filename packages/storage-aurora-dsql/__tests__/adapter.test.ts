import { describe, it, expect, beforeEach } from "vitest";
import { createDataRecord, createHLCClock } from "@starkeep/protocol-primitives";
import { StorageError, TransactionError } from "@starkeep/storage-adapter";
import { AuroraDsqlDatabaseAdapter } from "../src/adapter.js";
import { recordToRow } from "../src/serialization.js";
import type { DatabaseClient, DatabaseClientFactory } from "../src/types.js";

/** Records every query; per-pattern canned responses and failure injection. */
class FakeClient implements DatabaseClient {
  calls: { text: string; values?: unknown[] }[] = [];
  responses: Array<{ match: RegExp; rows: Record<string, unknown>[] }> = [];
  failOn: RegExp | null = null;
  ended = false;

  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    if (this.failOn?.test(text)) throw new Error(`injected failure on: ${text}`);
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

const clock = createHLCClock({ nodeId: "node-test" });

function sampleRecord() {
  return createDataRecord(
    {
      type: "jpg",
      originAppId: "photos",
      contentHash: "sha256:abc",
      objectStorageKey: "shared/jpg/ab/abc",
      mimeType: "image/jpeg",
      sizeBytes: 10,
    },
    clock,
  );
}

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

describe("lifecycle", () => {
  it("refuses queries before init", async () => {
    const cold = new AuroraDsqlDatabaseAdapter(
      { hostname: "fake.dsql", region: "us-east-1" },
      factoryOf(new FakeClient()),
    );
    await expect(cold.get(sampleRecord().id)).rejects.toThrow(StorageError);
  });

  it("close ends the client; healthCheck reflects connectivity", async () => {
    expect(await adapter.healthCheck()).toBe(true);
    client.failOn = /SELECT 1/;
    expect(await adapter.healthCheck()).toBe(false);
    await adapter.close();
    expect(client.ended).toBe(true);
    expect(await adapter.healthCheck()).toBe(false);
  });
});

describe("put / get / delete", () => {
  it("put issues an upsert over every column with ON CONFLICT(id)", async () => {
    const record = sampleRecord();
    await adapter.put(record);
    const [call] = client.calls;
    expect(call.text).toMatch(/^INSERT INTO shared\.records \(/);
    expect(call.text).toContain("ON CONFLICT(id) DO UPDATE SET");
    expect(call.text).toContain("updated_at = EXCLUDED.updated_at");
    // id must never be in the update list (it's the conflict key)
    expect(call.text).not.toContain("id = EXCLUDED.id,");
    expect(call.values).toEqual(Object.values(recordToRow(record)));
  });

  it("get round-trips a row and returns null on miss", async () => {
    const record = sampleRecord();
    client.responses.push({
      match: /SELECT \* FROM shared\.records WHERE id/,
      rows: [recordToRow(record) as unknown as Record<string, unknown>],
    });
    expect(await adapter.get(record.id)).toEqual(record);
    client.responses = [];
    expect(await adapter.get(record.id)).toBeNull();
  });

  it("delete writes a tombstone, bumping deleted_at and updated_at together", async () => {
    const record = sampleRecord();
    const hlc = clock.now();
    await adapter.delete(record.id, hlc);
    const [call] = client.calls;
    expect(call.text).toBe(
      "UPDATE shared.records SET deleted_at = $1, updated_at = $2 WHERE id = $3",
    );
    expect(call.values![0]).toBe(call.values![1]);
    expect(call.values![2]).toBe(record.id);
  });
});

describe("query pagination", () => {
  it("reports hasMore + nextCursor when limit+1 rows come back", async () => {
    const rows = [sampleRecord(), sampleRecord(), sampleRecord()].map(
      (r) => recordToRow(r) as unknown as Record<string, unknown>,
    );
    client.responses.push({ match: /select \*/, rows });
    const result = await adapter.query({ limit: 2 });
    expect(result.records).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(result.records[1].id);
  });

  it("reports no more pages when rows fit the limit", async () => {
    client.responses.push({
      match: /select \*/,
      rows: [recordToRow(sampleRecord()) as unknown as Record<string, unknown>],
    });
    const result = await adapter.query({ limit: 2 });
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

describe("savepoint transactions (DSQL shape)", () => {
  it("wraps the callback in SAVEPOINT … RELEASE on success", async () => {
    const record = sampleRecord();
    await adapter.transaction(async (tx) => {
      await tx.put(record);
    });
    expect(client.texts()).toEqual([
      "SAVEPOINT starkeep_transaction",
      expect.stringContaining("INSERT INTO shared.records"),
      "RELEASE SAVEPOINT starkeep_transaction",
    ]);
  });

  it("rolls back to the savepoint then releases it on failure", async () => {
    await expect(
      adapter.transaction(async () => {
        throw new Error("callback exploded");
      }),
    ).rejects.toThrow(TransactionError);
    expect(client.texts()).toEqual([
      "SAVEPOINT starkeep_transaction",
      "ROLLBACK TO SAVEPOINT starkeep_transaction",
      "RELEASE SAVEPOINT starkeep_transaction",
    ]);
  });
});

describe("batch", () => {
  it("brackets operations in BEGIN/COMMIT", async () => {
    const record = sampleRecord();
    await adapter.batch([
      { type: "put", record },
      { type: "delete", id: record.id, hlc: clock.now() },
    ]);
    const texts = client.texts();
    expect(texts[0]).toBe("BEGIN");
    expect(texts[texts.length - 1]).toBe("COMMIT");
    expect(texts.some((t) => t.startsWith("INSERT INTO shared.records"))).toBe(true);
    expect(texts.some((t) => t.startsWith("UPDATE shared.records SET deleted_at"))).toBe(true);
  });

  it("rolls back when an operation fails", async () => {
    client.failOn = /INSERT INTO shared\.records/;
    await expect(adapter.batch([{ type: "put", record: sampleRecord() }])).rejects.toThrow(
      /injected failure/,
    );
    const texts = client.texts();
    expect(texts[texts.length - 1]).toBe("ROLLBACK");
  });
});

describe("metadata tables", () => {
  it("upserts metadata into the category table derived from the type", async () => {
    const record = sampleRecord();
    await adapter.putMetadata("jpg", { recordId: record.id, width: 800, height: 600 });
    const [call] = client.calls;
    expect(call.text).toContain("INSERT INTO shared.record_image_metadata");
    expect(call.text).toContain("ON CONFLICT(record_id) DO UPDATE SET");
    expect(call.text).toContain("width = EXCLUDED.width");
    expect(call.values).toEqual([record.id, 800, 600]);
  });

  it("uses DO NOTHING when the row carries no columns beyond record_id", async () => {
    const record = sampleRecord();
    await adapter.putMetadata("jpg", { recordId: record.id });
    expect(client.calls[0].text).toContain("ON CONFLICT(record_id) DO NOTHING");
  });

  it("getMetadata round-trips and getMetadataByIds maps rows by record", async () => {
    const record = sampleRecord();
    client.responses.push({
      match: /SELECT \* FROM shared\.record_image_metadata/,
      rows: [{ record_id: record.id, width: 800 }],
    });
    expect(await adapter.getMetadata("jpg", record.id)).toEqual({
      recordId: record.id,
      width: 800,
    });
    const byIds = await adapter.getMetadataByIds("jpg", [record.id]);
    expect(byIds.get(record.id)).toEqual({ recordId: record.id, width: 800 });
    expect(await adapter.getMetadataByIds("jpg", [])).toEqual(new Map());
  });

  it("deleteMetadata targets the category table by record id", async () => {
    const record = sampleRecord();
    await adapter.deleteMetadata("jpg", record.id);
    expect(client.calls[0].text).toBe(
      "DELETE FROM shared.record_image_metadata WHERE record_id = $1",
    );
  });
});
