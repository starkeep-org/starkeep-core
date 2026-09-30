import { beforeEach, describe, expect, it } from "vitest";
import {
  compareHLC,
  createDataRecord,
  createHLCClock,
  DEFAULT_STAND_IN_STANDARDS as STD,
  summarizeStandIns,
  type DataRecord,
  type StandInStandards,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter } from "@starkeep/storage-adapter";
import {
  replaceImpact,
  restampOriginal,
  restampTarget,
  vetoRaisedStamp,
} from "../src/stand-ins/restamp.js";

const clock = createHLCClock({ nodeId: "desk" });
const BIG = 8 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg"];
const withImage = (canonicalThreshold: number): StandInStandards => ({
  ...STD,
  image: { ...STD.image, canonicalThreshold },
});
const withVideo = (canonicalThreshold: number): StandInStandards => ({
  ...STD,
  video: { ...STD.video, canonicalThreshold },
});

let db: MockDatabaseAdapter;
let n = 0;
beforeEach(async () => {
  db = new MockDatabaseAdapter();
  await db.init();
});

async function put(over: Partial<Parameters<typeof createDataRecord>[0]> = {}): Promise<DataRecord> {
  n += 1;
  const hash = `hash-${n}`;
  const r = createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: hash,
      objectStorageKey: `shared/image/aa/${hash}`,
      sizeBytes: BIG,
      ...over,
    },
    clock,
  );
  await db.put(r);
  return r;
}

const standIn = (parent: DataRecord, role: "canonical" | "smaller", fidelity: number) =>
  put({
    type: parent.type.startsWith("video/") ? "video/webm" : "image/avif",
    parentId: parent.id,
    standInRole: role,
    fidelity,
    sizeBytes: 1000,
  });

async function live(parent: DataRecord): Promise<Array<[string, number]>> {
  const result = await db.query({
    filters: [
      { field: "parentId", operator: "eq", value: parent.id },
      { field: "deletedAt", operator: "isNull" },
    ],
  });
  return result.records.map((r) => [r.standInRole!, r.fidelity!] as [string, number]).sort((a, b) => a[1] - b[1]);
}

describe("restampTarget", () => {
  it("names the new threshold for a stamped original that differs, and nothing otherwise", async () => {
    expect(restampTarget(await put({ fidelity: 6000, canonicalThreshold: 4272 }), withImage(2560))).toBe(2560);
    expect(restampTarget(await put({ fidelity: 6000, canonicalThreshold: 2560 }), withImage(2560))).toBeNull();
    expect(restampTarget(await put({ fidelity: 6000 }), withImage(2560))).toBeNull();
    expect(restampTarget(await put({ fidelity: null, canonicalThreshold: 4272 }), withImage(2560))).toBeNull();
  });
});

describe("restampOriginal", () => {
  it("promotes the smaller stand-in at a lowered threshold and retires what sits above it", async () => {
    const original = await put({ fidelity: 6000, canonicalThreshold: 4272 });
    await standIn(original, "canonical", 4272);
    await standIn(original, "smaller", 2560);
    await standIn(original, "smaller", 1280);

    const result = await restampOriginal(db, original, withImage(2560), clock);
    expect(result.promoted).toBe(true);
    expect((await db.get(original.id))!.canonicalThreshold).toBe(2560);
    expect(await live(original)).toEqual([
      ["smaller", 1280],
      ["canonical", 2560],
    ]);
    // The promoted stand-in is the one the original now expects.
    const summary = summarizeStandIns(
      (await db.get(original.id))! as DataRecord & { objectStorageKey: string },
      (await db.query({ filters: [{ field: "parentId", operator: "eq", value: original.id }] })).records as never,
      withImage(2560),
      () => "here",
    )!;
    expect(summary).toMatchObject({ canonicalOutdated: false, top: 2560 });
  });

  it("only restamps on a decrease with no smaller stand-in at the new value, leaving the canonical one outdated", async () => {
    const original = await put({ fidelity: 6000, canonicalThreshold: 4272 });
    await standIn(original, "canonical", 4272);
    const result = await restampOriginal(db, original, withImage(3200), clock);
    expect(result).toMatchObject({ promoted: false });
    expect(result.written).toHaveLength(1);
    expect(await live(original)).toEqual([["canonical", 4272]]);
  });

  it("retires the canonical stand-in of an image a raise makes self-canonical", async () => {
    const original = await put({ fidelity: 6000, canonicalThreshold: 4272 });
    await standIn(original, "canonical", 4272);
    await standIn(original, "smaller", 2560);
    await restampOriginal(db, original, withImage(8192), clock);
    expect(await live(original)).toEqual([["smaller", 2560]]);
  });

  it("clears the self-canonical flag when the new stamp falls below the original's fidelity", async () => {
    const lowered = await put({ type: "video/mp4", fidelity: 3000, canonicalThreshold: 4800 });
    await db.put({ ...lowered, selfCanonical: true });
    await restampOriginal(db, (await db.get(lowered.id))!, withVideo(2000), clock);
    expect(await db.get(lowered.id)).toMatchObject({ canonicalThreshold: 2000, selfCanonical: false });

    const raised = await put({ type: "video/mp4", fidelity: 3000, canonicalThreshold: 4800 });
    await db.put({ ...raised, selfCanonical: true });
    await restampOriginal(db, (await db.get(raised.id))!, withVideo(8000), clock);
    expect(await db.get(raised.id)).toMatchObject({ canonicalThreshold: 8000, selfCanonical: true });
  });

  it("writes every row under a fresh clock, the stamp first", async () => {
    const original = await put({ fidelity: 6000, canonicalThreshold: 4272 });
    await standIn(original, "canonical", 4272);
    await standIn(original, "smaller", 2560);
    const { written } = await restampOriginal(db, original, withImage(2560), clock);
    expect(written[0]!.id).toBe(original.id);
    for (let i = 1; i < written.length; i++) {
      expect(compareHLC(written[i - 1]!.updatedAt, written[i]!.updatedAt)).toBe(-1);
    }
  });
});

describe("replaceImpact", () => {
  it("counts what a decrease and a raise would each need", async () => {
    // Promoted: a 2560 stand-in already exists.
    const a = await put({ fidelity: 6000, canonicalThreshold: 4272 });
    await standIn(a, "canonical", 4272);
    await standIn(a, "smaller", 2560);
    // From the current canonical stand-in: no 2560 to promote.
    const b = await put({ fidelity: 6000, canonicalThreshold: 4272 });
    await standIn(b, "canonical", 4272);
    // Was self-canonical, now archivable: needs its original once.
    await put({ fidelity: 3000, canonicalThreshold: 4272 });
    // Already at the new value.
    await put({ fidelity: 6000, canonicalThreshold: 2560 });

    const lowered = await replaceImpact(db, withImage(2560), IMAGE_TYPES);
    expect(lowered.image).toEqual({ restamp: 3, promoted: 1, fromCanonical: 1, download: { count: 1, bytes: BIG } });

    // Raised to 8192, the 6000 px originals stand in for themselves, so the
    // replacement restamps all four and downloads nothing.
    const raised = await replaceImpact(db, withImage(8192), IMAGE_TYPES);
    expect(raised.image.restamp).toBe(4);
    expect(raised.image.download.count).toBe(0);

    // Raised to 5120, the three 6000 px originals — two stamped at 4272, one at
    // 2560 — need a larger canonical stand-in made from the original itself.
    const larger = await replaceImpact(db, withImage(5120), IMAGE_TYPES);
    expect(larger.image.download).toEqual({ count: 3, bytes: 3 * BIG });
  });
});

describe("vetoRaisedStamp", () => {
  async function archived(original: DataRecord, state: "archived" | "available") {
    await db.putAvailability({
      objectStorageKey: original.objectStorageKey!,
      state,
      tier: state === "archived" ? "DEEP_ARCHIVE" : null,
      expectedLatencyHours: state === "archived" ? 12 : null,
      readyAtMs: null,
      restoredUntilMs: null,
      observedAtMs: 1,
    } as never);
  }

  it("keeps an archived original's prior stamp against a raise, under a fresh clock", async () => {
    const current = await put({ fidelity: 12000, canonicalThreshold: 4272 });
    await archived(current, "archived");
    const incoming = { ...current, canonicalThreshold: 8192, updatedAt: clock.now(), version: 2 };
    const kept = await vetoRaisedStamp(db, current, incoming, clock);
    expect(kept).toMatchObject({ canonicalThreshold: 4272, version: 3 });
    expect(compareHLC(kept!.updatedAt, incoming.updatedAt)).toBe(1);
  });

  it("lets a decrease, an instant original and an unchanged stamp through", async () => {
    const current = await put({ fidelity: 12000, canonicalThreshold: 4272 });
    await archived(current, "archived");
    expect(await vetoRaisedStamp(db, current, { ...current, canonicalThreshold: 2560 }, clock)).toBeNull();
    expect(await vetoRaisedStamp(db, current, { ...current }, clock)).toBeNull();

    const instant = await put({ fidelity: 12000, canonicalThreshold: 4272 });
    await archived(instant, "available");
    expect(await vetoRaisedStamp(db, instant, { ...instant, canonicalThreshold: 8192 }, clock)).toBeNull();
  });
});
