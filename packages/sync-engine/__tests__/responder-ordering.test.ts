/**
 * The responder's shared-record apply order.
 *
 * Step 2 of `in-process-transport.ts` applies shared records per author in HLC
 * order, as step 1 does app rows. It used to iterate the wire order, which was
 * safe only because a shared-record `put()` that throws aborts the whole
 * exchange: no response, so no coverage report over a partially-applied author.
 * A halt is only safe over a contiguous prefix, and the sort keeps every
 * author's applied records contiguous.
 *
 * These cases pin the pair: out-of-order delivery converges (LWW does not care
 * what order snapshots arrive in); a failed apply still aborts; and a failure
 * now leaves nothing above it applied.
 */

import { describe, it, expect } from "vitest";
import {
  compareHLC,
  createDataRecord,
  generateId,
  type AnyRecord,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { buildSide } from "./sync-test-harness/side.js";

type Side = Awaited<ReturnType<typeof buildSide>>;

async function twoSides() {
  let t = 0;
  const wallClock = () => t++;
  return {
    local: await buildSide({ role: "local", nodeId: "L", wallClock, appId: "photos" }),
    cloud: await buildSide({ role: "cloud", nodeId: "C", wallClock, appId: "photos" }),
  };
}

/** A shared record authored by `nodeId` at `wallTime`, not stored anywhere yet. */
function authoredRecord(side: Side, nodeId: string, wallTime: number): AnyRecord {
  const id = generateId() as StarkeepId;
  const base = createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: `sha256:${id}`,
      objectStorageKey: "",
      mimeType: "image/jpeg",
      sizeBytes: 0,
    },
    side.clock,
  );
  return { ...base, id, updatedAt: { wallTime, counter: 0, nodeId } };
}

/**
 * Refuse `put` for one record id, leaving every other method — and the
 * adapter's own internal calls — untouched.
 *
 * Narrower than `failingMethod`: the question here is not "what does this
 * adapter do when writes fail", it is what the *responder* does when one row of
 * a multi-row author fails while the rows around it would have succeeded. A
 * blanket failure cannot express "a later row applied, an earlier one did not",
 * which is the whole shape of the finding.
 */
function refusingPutFor(db: DatabaseAdapter, id: StarkeepId): DatabaseAdapter {
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "put") {
        return async (record: AnyRecord) => {
          if (record.id === id) throw new Error("[test] injected put failure");
          return (value as (r: AnyRecord) => unknown).call(target, record);
        };
      }
      return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args);
    },
  }) as DatabaseAdapter;
}

function responderFor(cloud: Side, db: DatabaseAdapter = cloud.db) {
  return createInProcessSyncTransport({
    databaseAdapter: db,
    clock: cloud.clock,
    objectStorage: cloud.storage,
    syncSharedRecords: true,
  });
}

describe("shared records handed to the responder out of HLC order", () => {
  it("applies every one of them, because LWW does not read wire order", async () => {
    const { local, cloud } = await twoSides();
    const early = authoredRecord(local, "L", 10);
    const late = authoredRecord(local, "L", 20);

    const transport = responderFor(cloud);
    // Reversed: the later row first, exactly what a peer that shipped without
    // sorting would send.
    await transport.exchange({ watermarks: {}, records: [late, early] });

    expect(await cloud.db.get(early.id)).not.toBeNull();
    expect(await cloud.db.get(late.id)).not.toBeNull();
  });

  it("reports coverage over the whole author afterwards", async () => {
    const { local, cloud } = await twoSides();
    const early = authoredRecord(local, "L", 10);
    const late = authoredRecord(local, "L", 20);

    const transport = responderFor(cloud);
    const response = await transport.exchange({
      watermarks: {},
      records: [late, early],
    });

    const covered = response.responderWatermarks["L"];
    expect(covered).toBeDefined();
    // The watermark is a union of MAX, so it lands on the later row either way.
    // It is *honest* here only because both rows applied.
    expect(compareHLC(covered!, late.updatedAt)).toBe(0);
  });

  it("does not let an older snapshot arriving last undo a newer one", async () => {
    // The same record twice rather than two records: out-of-order delivery of
    // one row's history is where an unsorted apply would actually corrupt
    // state, if `put` were not an LWW-guarded snapshot write.
    const { local, cloud } = await twoSides();
    const older = authoredRecord(local, "L", 10);
    const newer = { ...older, updatedAt: { wallTime: 20, counter: 0, nodeId: "L" } };

    const transport = responderFor(cloud);
    await transport.exchange({ watermarks: {}, records: [newer, older] });

    const stored = await cloud.db.get(older.id);
    expect(stored).not.toBeNull();
    expect(compareHLC(stored!.updatedAt, newer.updatedAt)).toBe(0);
  });
});

describe("a shared-record apply that fails", () => {
  it("aborts the exchange rather than returning a response", async () => {
    // This is the assertion that fails the moment someone relaxes the throw.
    const { local, cloud } = await twoSides();
    const early = authoredRecord(local, "L", 10);
    const late = authoredRecord(local, "L", 20);

    const transport = responderFor(cloud, refusingPutFor(cloud.db, early.id));

    await expect(transport.exchange({ watermarks: {}, records: [late, early] })).rejects.toThrow(
      /injected put failure/,
    );
  });

  it("applies an author's records in HLC order whatever the wire order, so a failure leaves nothing above it", async () => {
    // The responder used to apply in wire order, so here the later row landed
    // before the earlier one failed, and its MAX(updated_at) sat above a row
    // it did not hold. Only the throw kept that map off the wire. Records now
    // apply per author in HLC order — a record that needs its file halts its
    // author without throwing, which is only safe over a contiguous prefix —
    // so the earlier row fails first and nothing above it lands.
    const { local, cloud } = await twoSides();
    const early = authoredRecord(local, "L", 10);
    const late = authoredRecord(local, "L", 20);

    const transport = responderFor(cloud, refusingPutFor(cloud.db, early.id));
    await expect(transport.exchange({ watermarks: {}, records: [late, early] })).rejects.toThrow();

    expect(await cloud.db.get(early.id), "the earlier row never landed").toBeNull();
    expect(await cloud.db.get(late.id), "nor did anything above it").toBeNull();
    expect((await cloud.db.getNodeWatermarks())["L"]).toBeUndefined();
  });

  it("costs nothing but a round, since the retry re-ships and LWW absorbs it", async () => {
    // The other half of the trade the comment describes: aborting is cheap
    // precisely because re-application is free. Same rows, working adapter.
    const { local, cloud } = await twoSides();
    const early = authoredRecord(local, "L", 10);
    const late = authoredRecord(local, "L", 20);

    const failing = responderFor(cloud, refusingPutFor(cloud.db, early.id));
    await expect(failing.exchange({ watermarks: {}, records: [late, early] })).rejects.toThrow();

    const retry = responderFor(cloud);
    const response = await retry.exchange({ watermarks: {}, records: [late, early] });

    expect(await cloud.db.get(early.id)).not.toBeNull();
    expect(await cloud.db.get(late.id)).not.toBeNull();
    expect(compareHLC(response.responderWatermarks["L"]!, late.updatedAt)).toBe(0);
  });
});
