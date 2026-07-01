import { describe, it, expect, beforeEach } from "vitest";
import { createHLCClock } from "@starkeep/protocol-primitives";
import type {
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  AppSyncableRowEntry,
} from "@starkeep/sync-engine";
import { DsqlAppSyncableApplier } from "../src/app-syncable/apply.js";
import type { DatabaseClient } from "../src/types.js";

function occConflict(): Error {
  return Object.assign(new Error("change conflicts with another transaction"), {
    code: "OC001",
  });
}

class FakeClient implements DatabaseClient {
  calls: { text: string; values?: unknown[] }[] = [];
  conflicts: Array<{ match: RegExp; remaining: number }> = [];

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
    return { rows: [] };
  }

  async end() {}
}

const ns: AppSyncableNamespace = {
  appId: "notes",
  tables: [{ name: "note", pkColumns: ["id"] }],
  filesEnabled: false,
  tableNames: ["note"],
};

const namespaceStore: AppSyncableNamespaceStore = {
  get: (appId) => (appId === "notes" ? ns : null),
  list: () => [ns],
};

const clock = createHLCClock({ nodeId: "node-test" });

let client: FakeClient;
let applier: DsqlAppSyncableApplier;

beforeEach(() => {
  client = new FakeClient();
  applier = new DsqlAppSyncableApplier(client, namespaceStore);
});

function insertEntry(): AppSyncableRowEntry {
  const ts = clock.now();
  return {
    timestamp: ts,
    appId: "notes",
    table: "note",
    op: "insert",
    row: { id: "n1", body: "hi", updated_at: "0", deleted_at: null },
  };
}

describe("DsqlAppSyncableApplier OCC retry", () => {
  it("retries the LWW upsert past an OCC conflict", async () => {
    client.conflictOnce(/INSERT INTO/, 2);
    await applier.apply(insertEntry());
    const inserts = client.calls.filter((c) => /INSERT INTO/.test(c.text));
    expect(inserts).toHaveLength(3); // two conflicts + one that committed
  });

  it("does not retry a non-OCC error", async () => {
    client.query = async (text: string) => {
      client.calls.push({ text });
      throw Object.assign(new Error("boom"), { code: "42P01" }); // undefined_table
    };
    await expect(applier.apply(insertEntry())).rejects.toThrow("boom");
    expect(client.calls).toHaveLength(1);
  });
});
