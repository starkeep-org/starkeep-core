import { describe, it, expect, beforeEach } from "vitest";
import { createDataRecord, createHLCClock } from "@starkeep/protocol-primitives";
import { StorageError, TransactionError } from "@starkeep/storage-adapter";
import { AuroraDsqlDatabaseAdapter } from "../src/adapter.js";
import { recordToRow } from "../src/serialization.js";
import type { DatabaseClient, DatabaseClientFactory } from "../src/types.js";

/** A DSQL OCC-conflict shaped error (pg surfaces the code on the error). */
function occConflict(): Error {
  return Object.assign(new Error("change conflicts with another transaction"), {
    code: "OC001",
  });
}

/** Records every query; per-pattern canned responses and failure injection. */
class FakeClient implements DatabaseClient {
  calls: { text: string; values?: unknown[] }[] = [];
  responses: Array<{ match: RegExp; rows: Record<string, unknown>[] }> = [];
  failOn: RegExp | null = null;
  // Throw an OCC conflict the first `remaining` times a matching query runs,
  // then let it through — simulates a transaction that loses the OCC race a
  // bounded number of times before committing.
  conflicts: Array<{ match: RegExp; remaining: number }> = [];
  ended = false;

  conflictOnce(match: RegExp, times = 1) {
    this.conflicts.push({ match, remaining: times });
  }

  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    if (this.failOn?.test(text)) throw new Error(`injected failure on: ${text}`);
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

const clock = createHLCClock({ nodeId: "node-test" });

function sampleRecord() {
  return createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: "sha256:abc",
      objectStorageKey: "shared/image/ab/abc",
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

  it("delete writes a tombstone, bumping deleted_at, updated_at and node_id together", async () => {
    const record = sampleRecord();
    const hlc = clock.now();
    await adapter.delete(record.id, hlc);
    const [call] = client.calls;
    expect(call.text).toBe(
      "UPDATE shared.records SET deleted_at = $1, updated_at = $2, node_id = $3 WHERE id = $4",
    );
    expect(call.values![0]).toBe(call.values![1]);
    expect(call.values![2]).toBe(hlc.nodeId);
    expect(call.values![3]).toBe(record.id);
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

describe("OCC retry", () => {
  it("retries put past OCC conflicts until the upsert commits", async () => {
    client.conflictOnce(/INSERT INTO shared\.records/, 2);
    await adapter.put(sampleRecord());
    const inserts = client
      .texts()
      .filter((t) => t.startsWith("INSERT INTO shared.records"));
    // Two conflicted attempts + one that committed.
    expect(inserts).toHaveLength(3);
  });

  it("does NOT retry a non-OCC failure — it propagates on the first attempt", async () => {
    client.failOn = /INSERT INTO shared\.records/;
    await expect(adapter.put(sampleRecord())).rejects.toThrow(/injected failure/);
    const inserts = client
      .texts()
      .filter((t) => t.startsWith("INSERT INTO shared.records"));
    expect(inserts).toHaveLength(1);
  });

  it("replays the whole BEGIN…COMMIT when COMMIT loses the OCC race", async () => {
    client.conflictOnce(/COMMIT/, 1);
    await adapter.batch([{ type: "put", record: sampleRecord() }]);
    const texts = client.texts();
    // First attempt: BEGIN, INSERT, COMMIT(conflict) -> ROLLBACK.
    // Second attempt: BEGIN, INSERT, COMMIT(ok).
    expect(texts.filter((t) => t === "BEGIN")).toHaveLength(2);
    expect(texts.filter((t) => t === "COMMIT")).toHaveLength(2); // conflicted + committed
    expect(texts.filter((t) => t === "ROLLBACK")).toHaveLength(1);
  });

  it("replays the whole SAVEPOINT…RELEASE when RELEASE loses the OCC race", async () => {
    client.conflictOnce(/RELEASE SAVEPOINT/, 1);
    let callbackRuns = 0;
    await adapter.transaction(async (tx) => {
      callbackRuns++;
      await tx.put(sampleRecord());
    });
    // Callback replayed once because the savepoint release conflicted.
    expect(callbackRuns).toBe(2);
    const texts = client.texts();
    expect(texts.filter((t) => t === "SAVEPOINT starkeep_transaction")).toHaveLength(2);
  });
});

describe("metadata tables", () => {
  it("upserts metadata into the category table derived from the type", async () => {
    const record = sampleRecord();
    await adapter.putMetadata("image/jpeg", { recordId: record.id, width: 800, height: 600 });
    const [call] = client.calls;
    expect(call.text).toContain("INSERT INTO shared.record_image_metadata");
    expect(call.text).toContain("ON CONFLICT(record_id) DO UPDATE SET");
    expect(call.text).toContain("width = EXCLUDED.width");
    expect(call.values).toEqual([record.id, 800, 600]);
  });

  it("uses DO NOTHING when the row carries no columns beyond record_id", async () => {
    const record = sampleRecord();
    await adapter.putMetadata("image/jpeg", { recordId: record.id });
    expect(client.calls[0].text).toContain("ON CONFLICT(record_id) DO NOTHING");
  });

  it("getMetadata round-trips and getMetadataByIds maps rows by record", async () => {
    const record = sampleRecord();
    client.responses.push({
      match: /SELECT \* FROM shared\.record_image_metadata/,
      rows: [{ record_id: record.id, width: 800 }],
    });
    expect(await adapter.getMetadata("image/jpeg", record.id)).toEqual({
      recordId: record.id,
      width: 800,
    });
    const byIds = await adapter.getMetadataByIds("image/jpeg", [record.id]);
    expect(byIds.get(record.id)).toEqual({ recordId: record.id, width: 800 });
    expect(await adapter.getMetadataByIds("image/jpeg", [])).toEqual(new Map());
  });

  it("deleteMetadata targets the category table by record id", async () => {
    const record = sampleRecord();
    await adapter.deleteMetadata("image/jpeg", record.id);
    expect(client.calls[0].text).toBe(
      "DELETE FROM shared.record_image_metadata WHERE record_id = $1",
    );
  });
});
