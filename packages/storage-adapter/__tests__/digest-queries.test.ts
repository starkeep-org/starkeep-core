/**
 * The digest primitives, on their own.
 *
 * These functions had no test file of their own — they were reached only
 * through storage-sqlite and the sync engine, which meant the properties they
 * are *chosen* for were asserted nowhere. Two of those properties are load-
 * bearing in a way that is easy to break by a reasonable-looking edit:
 *
 *   - `bucketsPeerIsMissing` is one-directional on purpose. A bucket where the
 *     peer holds more is ordinary data we have not pulled yet, not a hole.
 *   - `applyRepairFloors` will *raise* an advertised watermark from "nothing at
 *     all from this author" to "everything up to the floor". That is only sound
 *     because `repairFloorsFor` returns the **lowest** disagreeing bucket per
 *     author. Nothing else states that dependency, so it is stated here, as a
 *     test that fails if either half stops holding up its end.
 */

import { describe, it, expect } from "vitest";
import { serializeHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";
import {
  applyRepairFloors,
  bucketsPeerIsMissing,
  mergeDigestBuckets,
  repairFloorsFor,
  totalRows,
  DEFAULT_BUCKET_PREFIX_LENGTH,
  type DigestBucket,
} from "../src/database/digest-queries.js";

function bucket(nodeId: string, b: string, count: number): DigestBucket {
  return { nodeId, bucket: b, count };
}

/** The bucket a given wall-clock millisecond falls in, at the default width. */
function bucketOf(wallTime: number, nodeId = "L"): string {
  return serializeHLC({ wallTime, counter: 0, nodeId }).slice(
    0,
    DEFAULT_BUCKET_PREFIX_LENGTH,
  );
}

describe("mergeDigestBuckets", () => {
  it("sums counts for the same author and bucket across tables", () => {
    // Records and labels are one channel under one watermark, so their digests
    // fold together — a digest over half of it would report agreement while a
    // label went missing.
    const merged = mergeDigestBuckets([
      bucket("L", "00001", 3),
      bucket("L", "00001", 2),
      bucket("L", "00002", 1),
      bucket("C", "00001", 4),
    ]);
    expect(merged).toEqual(
      expect.arrayContaining([
        bucket("L", "00001", 5),
        bucket("L", "00002", 1),
        bucket("C", "00001", 4),
      ]),
    );
    expect(merged).toHaveLength(3);
  });

  it("does not mutate its input", () => {
    const input = [bucket("L", "00001", 3), bucket("L", "00001", 2)];
    mergeDigestBuckets(input);
    expect(input[0]!.count).toBe(3);
  });

  it("returns nothing for nothing", () => {
    expect(mergeDigestBuckets([])).toEqual([]);
  });
});

describe("bucketsPeerIsMissing", () => {
  it("reports a bucket where the peer holds fewer rows", () => {
    const missing = bucketsPeerIsMissing(
      [bucket("L", "00001", 5)],
      [bucket("L", "00001", 3)],
    );
    expect(missing).toEqual([bucket("L", "00001", 5)]);
  });

  it("reports a bucket the peer does not have at all", () => {
    const missing = bucketsPeerIsMissing([bucket("L", "00001", 5)], []);
    expect(missing).toEqual([bucket("L", "00001", 5)]);
  });

  it("says nothing about a bucket where the peer holds more", () => {
    // The one-directionality. Swapping the arguments asks the *other*
    // question — "is my library whole?" — and answering it with this
    // comparison run one way would flag every row we have not pulled yet.
    expect(
      bucketsPeerIsMissing([bucket("L", "00001", 3)], [bucket("L", "00001", 5)]),
    ).toEqual([]);
  });

  it("keeps authors separate", () => {
    // A peer that holds plenty from author C says nothing about what it holds
    // from author L, and counting across authors would hide a whole device.
    expect(
      bucketsPeerIsMissing([bucket("L", "00001", 3)], [bucket("C", "00001", 9)]),
    ).toEqual([bucket("L", "00001", 3)]);
  });

  it("keeps buckets separate", () => {
    expect(
      bucketsPeerIsMissing([bucket("L", "00002", 3)], [bucket("L", "00001", 9)]),
    ).toEqual([bucket("L", "00002", 3)]);
  });

  it("agrees when the counts agree", () => {
    expect(
      bucketsPeerIsMissing([bucket("L", "00001", 3)], [bucket("L", "00001", 3)]),
    ).toEqual([]);
  });
});

describe("repairFloorsFor", () => {
  it("puts the floor just below the bucket's first millisecond", () => {
    // Every scan bound in the system is exclusive (`updated_at > floor`), so a
    // floor *at* the bucket start would skip a row landing exactly on the
    // boundary — the row a repair can least afford to miss.
    const wallTime = 1_700_000_000_000;
    const floors = repairFloorsFor([bucket("L", bucketOf(wallTime), 1)]);
    const floor = floors["L"]!;
    expect(floor.wallTime).toBe(bucketStartMsOf(wallTime) - 1);
    expect(floor.counter).toBe(0xffff);
    expect(floor.nodeId).toBe("L");
  });

  it("takes the lowest disagreeing bucket per author", () => {
    // One monotonic re-ship per author rather than a repair per bucket, which
    // is what lets the ordinary delta scan carry the repair out with no second
    // code path — and what `applyRepairFloors` depends on for its safety.
    const early = bucketOf(1_500_000_000_000);
    const late = bucketOf(1_900_000_000_000);
    const floors = repairFloorsFor([
      bucket("L", late, 1),
      bucket("L", early, 1),
      bucket("L", late, 1),
    ]);
    expect(floors["L"]!.wallTime).toBe(bucketStartMsOf(1_500_000_000_000) - 1);
  });

  it("floors the earliest bucket at zero rather than underflowing", () => {
    const floors = repairFloorsFor([bucket("L", "00000", 1)]);
    expect(floors["L"]).toEqual({ wallTime: 0, counter: 0, nodeId: "L" });
  });

  it("gives each author its own floor", () => {
    const floors = repairFloorsFor([
      bucket("L", bucketOf(1_500_000_000_000), 1),
      bucket("C", bucketOf(1_900_000_000_000), 1),
    ]);
    expect(Object.keys(floors).sort()).toEqual(["C", "L"]);
    expect(floors["C"]!.wallTime).toBeGreaterThan(floors["L"]!.wallTime);
  });

  it("returns nothing when nothing disagrees", () => {
    expect(repairFloorsFor([])).toEqual({});
  });
});

describe("applyRepairFloors", () => {
  const high: HLCTimestamp = { wallTime: 900, counter: 0, nodeId: "L" };
  const low: HLCTimestamp = { wallTime: 100, counter: 0, nodeId: "L" };

  it("lowers a watermark to the floor", () => {
    expect(applyRepairFloors({ L: high }, { L: low })).toEqual({ L: low });
  });

  it("leaves a watermark that is already lower alone", () => {
    expect(applyRepairFloors({ L: low }, { L: high })).toEqual({ L: low });
  });

  it("adopts the floor for an author with no watermark at all", () => {
    // The branch worth naming: on the inbound side this *raises* what we
    // advertise, from "nothing from this author" to "everything up to the
    // floor". Sound only because the floor is the lowest disagreeing bucket,
    // so nothing is owed below it. A floor taken from a mid-range bucket would
    // make this line claim coverage over rows we never received — and the peer
    // would never send them again.
    expect(applyRepairFloors({}, { L: low })).toEqual({ L: low });
  });

  it("leaves other authors untouched", () => {
    const c: HLCTimestamp = { wallTime: 500, counter: 0, nodeId: "C" };
    expect(applyRepairFloors({ L: high, C: c }, { L: low })).toEqual({ L: low, C: c });
  });

  it("returns the same map when there are no floors", () => {
    const watermarks = { L: high };
    expect(applyRepairFloors(watermarks, {})).toBe(watermarks);
  });

  it("does not mutate the watermarks it was given", () => {
    const watermarks = { L: high };
    applyRepairFloors(watermarks, { L: low });
    expect(watermarks["L"]).toBe(high);
  });

  it("re-requests everything above the lowest hole, and nothing below it", () => {
    // The two functions as one contract, which is how they are actually used:
    // a disagreement in a late bucket must not lower the advertised watermark
    // below the *earliest* disagreement, and must not leave it above it.
    const holes = [
      bucket("L", bucketOf(1_800_000_000_000), 1),
      bucket("L", bucketOf(1_600_000_000_000), 1),
    ];
    const caughtUp: HLCTimestamp = { wallTime: 1_900_000_000_000, counter: 0, nodeId: "L" };
    const repaired = applyRepairFloors({ L: caughtUp }, repairFloorsFor(holes));
    expect(repaired["L"]!.wallTime).toBe(bucketStartMsOf(1_600_000_000_000) - 1);
  });
});

describe("totalRows", () => {
  it("sums every bucket, which is what 'is my library backed up' reads", () => {
    expect(totalRows([bucket("L", "00001", 3), bucket("C", "00002", 4)])).toBe(7);
  });

  it("is zero for an empty digest", () => {
    expect(totalRows([])).toBe(0);
  });
});

/** First millisecond of the bucket `wallTime` falls in, at the default width. */
function bucketStartMsOf(wallTime: number): number {
  return parseInt(bucketOf(wallTime).padEnd(12, "0"), 16);
}
