/**
 * The responder's shared-record apply order, and the throw that makes it safe.
 *
 * Round 3's R11.1: step 2 of `in-process-transport.ts` iterates the *wire
 * order* and does not sort, while step 1 sorts app rows per author before
 * applying them. The asymmetry is deliberate and it is load-bearing on a single
 * fact — **a shared-record `put()` that throws aborts the whole exchange** — so
 * no response is produced, no coverage watermark is reported over a
 * partially-applied author, and the requester simply re-ships next round.
 *
 * That argument is written down at the call site. What was missing was a test
 * that fails when someone relaxes the throw, which is exactly the change the
 * comment warns against: catch the apply error and fold the author into
 * `haltedNodes` the way app rows are, and the missing sort stops being harmless
 * and becomes silent loss under a watermark claiming coverage.
 *
 * So these cases pin the pair. Out-of-order delivery converges (LWW does not
 * care what order snapshots arrive in); a failed apply *aborts*; and — the case
 * that shows why the abort is the only thing holding the invariant up — after
 * the failed apply the responder's own coverage watermark already sits above
 * the row it dropped. The response that is never sent is the one that would
 * have lied.
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
      return (...args: unknown[]) =>
        (value as (...a: unknown[]) => unknown).apply(target, args);
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

    await expect(
      transport.exchange({ watermarks: {}, records: [late, early] }),
    ).rejects.toThrow(/injected put failure/);
  });

  it("leaves a coverage watermark that would overstate what landed", async () => {
    // The reason the abort is not merely tidy. The later row applied before the
    // earlier one failed, so the responder's own `getNodeWatermarks` — a
    // MAX(updated_at) per author — now sits *above* a row it does not hold.
    // Any response built from it claims coverage of the dropped row, and the
    // requester's authoritative replace would stop re-shipping it forever.
    //
    // Nothing rescues that except never sending the response, which is what the
    // throw does. Catch it and fold the author into `haltedNodes` — the obvious
    // symmetry with step 1 — and this map is what would go on the wire.
    const { local, cloud } = await twoSides();
    const early = authoredRecord(local, "L", 10);
    const late = authoredRecord(local, "L", 20);

    const transport = responderFor(cloud, refusingPutFor(cloud.db, early.id));
    await expect(
      transport.exchange({ watermarks: {}, records: [late, early] }),
    ).rejects.toThrow();

    expect(await cloud.db.get(early.id), "the earlier row never landed").toBeNull();
    const watermarks = await cloud.db.getNodeWatermarks();
    expect(compareHLC(watermarks["L"]!, early.updatedAt)).toBeGreaterThan(0);
  });

  it("costs nothing but a round, since the retry re-ships and LWW absorbs it", async () => {
    // The other half of the trade the comment describes: aborting is cheap
    // precisely because re-application is free. Same rows, working adapter.
    const { local, cloud } = await twoSides();
    const early = authoredRecord(local, "L", 10);
    const late = authoredRecord(local, "L", 20);

    const failing = responderFor(cloud, refusingPutFor(cloud.db, early.id));
    await expect(
      failing.exchange({ watermarks: {}, records: [late, early] }),
    ).rejects.toThrow();

    const retry = responderFor(cloud);
    const response = await retry.exchange({ watermarks: {}, records: [late, early] });

    expect(await cloud.db.get(early.id)).not.toBeNull();
    expect(await cloud.db.get(late.id)).not.toBeNull();
    expect(compareHLC(response.responderWatermarks["L"]!, late.updatedAt)).toBe(0);
  });
});
