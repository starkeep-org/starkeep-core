import { describe, expect, it } from "vitest";
import {
  SHARED_CHANNEL,
  appChannel,
  buildChangeHeadReplace,
  guardChangeHeads,
} from "../src/change-heads.js";
import { ownerScopedCompiler, typeScopedCompiler } from "../src/query-builder.js";
import type { DatabaseClient } from "../src/types.js";

/** A client that records what reached it. */
function recording(): DatabaseClient & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    async query(text) {
      texts.push(text);
      return { rows: [] };
    },
    async end() {},
  };
}

const qb = ownerScopedCompiler("user-a");
const RECORD_WRITE = qb.insertInto("shared.records").values({ id: "r1" }).compile();
const CARD_WRITE = qb.insertInto("app_memo.cards").values({ id: "c1" }).compile();
const run = (client: DatabaseClient, q: { sql: string; parameters: readonly unknown[] }) =>
  client.query(q.sql, [...q.parameters]);

describe("guardChangeHeads", () => {
  it("lets a write through when its transaction replaces its channel's head", async () => {
    const inner = recording();
    const client = guardChangeHeads(inner);
    await client.query("BEGIN");
    await run(client, RECORD_WRITE);
    await run(client, buildChangeHeadReplace(qb, SHARED_CHANNEL));
    await client.query("COMMIT");
    expect(inner.texts.at(-1)).toBe("COMMIT");
  });

  it("refuses a write to a synced table outside a transaction, before it runs", async () => {
    const inner = recording();
    await expect(run(guardChangeHeads(inner), RECORD_WRITE)).rejects.toThrow(
      /outside a transaction/,
    );
    expect(inner.texts).toEqual([]);
  });

  it("refuses the COMMIT of a write whose head was not replaced, and rolls it back", async () => {
    const inner = recording();
    const client = guardChangeHeads(inner);
    await client.query("BEGIN");
    await run(client, CARD_WRITE);
    await expect(client.query("COMMIT")).rejects.toThrow(/app_memo/);
    expect(inner.texts.at(-1)).toBe("ROLLBACK");
  });

  it("does not count another channel's head", async () => {
    const client = guardChangeHeads(recording());
    await client.query("BEGIN");
    await run(client, CARD_WRITE);
    await run(client, buildChangeHeadReplace(qb, SHARED_CHANNEL));
    await expect(client.query("COMMIT")).rejects.toThrow(/app_memo/);
  });

  it("forgets a rolled-back transaction", async () => {
    const client = guardChangeHeads(recording());
    await client.query("BEGIN");
    await run(client, CARD_WRITE);
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query("COMMIT");
  });

  it("refuses every write to the heads but the replacement", async () => {
    const client = guardChangeHeads(recording());
    const chosen = qb
      .updateTable("shared.change_heads")
      .set({ token: "an-old-token" })
      .where("channel", "=", SHARED_CHANNEL)
      .compile();
    await expect(run(client, chosen)).rejects.toThrow(/refused a write to the change heads/);
    const removed = qb.deleteFrom("shared.change_heads").compile();
    await expect(run(client, removed)).rejects.toThrow(/refused a write to the change heads/);
  });

  it("accepts the replacement from a type-scoped compiler, whose inserts are unchanged", async () => {
    const client = guardChangeHeads(recording());
    await client.query("BEGIN");
    await run(client, RECORD_WRITE);
    await run(
      client,
      buildChangeHeadReplace(typeScopedCompiler("user-a", ["image/jpeg"]), SHARED_CHANNEL),
    );
    await client.query("COMMIT");
  });

  it("leaves tables no exchange carries alone", async () => {
    const client = guardChangeHeads(recording());
    await run(
      client,
      qb.insertInto("shared.object_availability").values({ object_storage_key: "k" }).compile(),
    );
    await run(
      client,
      qb.insertInto("app_memo._starkeep_byte_coverage").values({ node_id: "n" }).compile(),
    );
    await run(client, qb.selectFrom("shared.change_heads").select("token").compile());
  });

  it("names an app's channel by its schema", () => {
    expect(appChannel("starkeep-drive")).toBe("app_starkeep_drive");
  });

  it("wraps a client once", () => {
    const client = guardChangeHeads(recording());
    expect(guardChangeHeads(client)).toBe(client);
  });
});
