import { describe, expect, it } from "vitest";
import {
  ARCHIVE_SIZE_FLOOR_BYTES,
  DEFAULT_SYNC_DOWN_CEILINGS,
  ceilingPlacement,
  DEFAULT_STAND_IN_STANDARDS as STD,
  checkOriginalFidelity,
  canonicalMatches,
  checkStandInWrite,
  expectedCanonicalFidelity,
  isStandInOriginal,
  originalStatus,
  resolveSize,
  stampFor,
  standardSizesOf,
  standInSlot,
  summarizeStandIns,
  thresholdOf,
  topFidelity,
  validateStandInStandards,
  type StandInFacts,
  type StandInStandards,
  type SummaryStandIn,
} from "../src/index.js";

const BIG = ARCHIVE_SIZE_FLOOR_BYTES * 8;
const SMALL = ARCHIVE_SIZE_FLOOR_BYTES / 2;

function original(over: Partial<StandInFacts> = {}): StandInFacts & { objectStorageKey: string } {
  return {
    id: "orig",
    type: "image/jpeg",
    parentId: null,
    standInRole: null,
    fidelity: 6000,
    sizeBytes: BIG,
    objectStorageKey: "shared/image/aa/orig",
    ...over,
  };
}

function standIn(
  role: "canonical" | "smaller",
  fidelity: number,
  over: Partial<SummaryStandIn> = {},
): SummaryStandIn {
  return {
    id: `si-${role}-${fidelity}`,
    type: "image/avif",
    parentId: "orig",
    standInRole: role,
    fidelity,
    sizeBytes: 1000,
    objectStorageKey: `shared/image/bb/${role}-${fidelity}`,
    ...over,
  };
}

describe("the default standards", () => {
  it("are internally consistent", () => {
    expect(validateStandInStandards(STD)).toEqual([]);
  });

  it("refuse a standard size at or above the threshold", () => {
    const broken: StandInStandards = {
      ...STD,
      image: { ...STD.image, standardSizes: [320, 4272] },
    };
    expect(validateStandInStandards(broken).join("\n")).toMatch(/not below the canonical threshold/);
  });

  it("refuse sizes that do not ascend", () => {
    const broken: StandInStandards = {
      ...STD,
      image: { ...STD.image, standardSizes: [640, 320] },
    };
    expect(validateStandInStandards(broken).join("\n")).toMatch(/ascend/);
  });

  it("refuse a standard size with no advisory long edge", () => {
    const broken: StandInStandards = {
      ...STD,
      video: { ...STD.video, standardSizes: [1000, 2000] },
    };
    expect(validateStandInStandards(broken).join("\n")).toMatch(/standard size 1000 has no advisory long edge/);
  });

  it("publish video in kbps with 1080p and 720p advisory long edges", () => {
    expect(STD.video.fidelityAxis).toBe("kbps");
    expect(STD.video.canonicalThreshold).toBe(4800);
    expect(STD.video.standardSizes).toEqual([2000]);
    expect(STD.video.advisoryLongEdges).toEqual({ canonical: 1920, bySize: { 2000: 1280 } });
    expect(STD.image.advisoryLongEdges).toBeNull();
  });

  it("refuse an allowed type outside its category", () => {
    const broken: StandInStandards = {
      ...STD,
      video: { ...STD.video, allowedTypes: ["image/avif"] },
    };
    expect(validateStandInStandards(broken).join("\n")).toMatch(/outside the category/);
  });
});

describe("originalStatus", () => {
  const cases: Array<[string, Partial<StandInFacts>, string | null]> = [
    ["image above the threshold and the floor", { fidelity: 6000 }, "archivable"],
    ["image at the threshold", { fidelity: 4272 }, "self-canonical"],
    ["image below the threshold", { fidelity: 3000 }, "self-canonical"],
    ["image below the floor, even when huge", { fidelity: 9000, sizeBytes: SMALL }, "self-canonical"],
    ["image below the floor with no fidelity", { fidelity: null, sizeBytes: SMALL }, "self-canonical"],
    ["image with no fidelity", { fidelity: null }, "fidelity-unknown"],
    ["video above the threshold", { type: "video/mp4", fidelity: 12000 }, "archivable"],
    ["video below the threshold", { type: "video/mp4", fidelity: 3000 }, "archivable"],
    ["video below the floor", { type: "video/mov", fidelity: 3000, sizeBytes: SMALL }, "video-below-floor"],
    ["video with no fidelity", { type: "video/mp4", fidelity: null }, "fidelity-unknown"],
    // Audio has no stand-in standards, so it is an ordinary file like a document.
    ["lossless audio", { type: "audio/flac", fidelity: 900 }, null],
    ["a document", { type: "document/pdf", fidelity: null }, null],
  ];
  for (const [name, over, expected] of cases) {
    it(name, () => {
      expect(originalStatus(original(over), STD)).toBe(expected);
    });
  }
});

describe("expectedCanonicalFidelity and topFidelity", () => {
  it("is the threshold for an archivable image", () => {
    expect(expectedCanonicalFidelity(original(), STD)).toBe(4272);
  });

  it("is the original's own bitrate for a video below the threshold", () => {
    expect(expectedCanonicalFidelity(original({ type: "video/mp4", fidelity: 3000 }), STD)).toBe(3000);
    expect(expectedCanonicalFidelity(original({ type: "video/mp4", fidelity: 12000 }), STD)).toBe(4800);
  });

  it("is null for a self-canonical original, whose own fidelity is the top", () => {
    const o = original({ fidelity: 3000 });
    expect(expectedCanonicalFidelity(o, STD)).toBeNull();
    expect(topFidelity(o, null, STD)).toBe(3000);
  });

  it("prefers an existing canonical stand-in over the expected value", () => {
    expect(topFidelity(original(), { fidelity: 5000 }, STD)).toBe(5000);
  });
});

describe("an original judged by its own stamp", () => {
  // The library's value moved from the default to 2560 after these originals
  // were stamped, or before the unstamped one was.
  const LOWERED: StandInStandards = { ...STD, image: { ...STD.image, canonicalThreshold: 2560 } };

  it("reads the stamp first and the library value only for an unstamped original", () => {
    expect(thresholdOf(original({ canonicalThreshold: 4272 }), LOWERED)).toBe(4272);
    expect(thresholdOf(original(), LOWERED)).toBe(2560);
    expect(thresholdOf(original({ type: "document/pdf" }), LOWERED)).toBeNull();
  });

  it("keeps a stamped original's status, expected fidelity and sizes when the library value moves", () => {
    const stamped = original({ fidelity: 4000, canonicalThreshold: 4272 });
    expect(originalStatus(stamped, LOWERED)).toBe("self-canonical");
    expect(standardSizesOf(stamped, LOWERED)).toEqual([320, 640, 1280, 2560]);

    const unstamped = original({ fidelity: 4000 });
    expect(originalStatus(unstamped, LOWERED)).toBe("archivable");
    expect(expectedCanonicalFidelity(unstamped, LOWERED)).toBe(2560);
    expect(standardSizesOf(unstamped, LOWERED)).toEqual([320, 640, 1280]);
    expect(topFidelity(unstamped, null, LOWERED)).toBe(2560);
  });

  it("stamps with the library's value only when the node knows it", () => {
    expect(stampFor("image/jpeg", LOWERED, true)).toBe(2560);
    expect(stampFor("image/jpeg", LOWERED, false)).toBeNull();
    expect(stampFor("document/pdf", LOWERED, true)).toBeNull();
  });

  it("tells a canonical stand-in made for the stamp from an outdated one", () => {
    const stamped = original({ canonicalThreshold: 2560 });
    expect(canonicalMatches(stamped, { fidelity: 2560 }, STD)).toBe(true);
    expect(canonicalMatches(stamped, { fidelity: 4272 }, STD)).toBe(false);
  });
});

describe("an original whose canonical encode could not shrink it", () => {
  it("stands in for itself, a video included, and so never archives", () => {
    const video = original({ type: "video/mp4", fidelity: 3000, selfCanonical: true });
    expect(originalStatus(video, STD)).toBe("self-canonical");
    expect(expectedCanonicalFidelity(video, STD)).toBeNull();
    expect(topFidelity(video, null, STD)).toBe(3000);
  });

  it("sits within a ceiling at its own fidelity", () => {
    const video = original({ type: "video/mp4", fidelity: 1500, selfCanonical: true });
    expect(ceilingPlacement(video, { image: null, video: 2000 }, STD)).toBe("within");
    expect(ceilingPlacement({ ...video, selfCanonical: false }, { image: null, video: 2000 }, STD)).toBe("above");
  });
});

describe("isStandInOriginal", () => {
  it("is true only for a parentless, roleless record in a stand-in category", () => {
    expect(isStandInOriginal(original())).toBe(true);
    expect(isStandInOriginal(original({ parentId: "x" }))).toBe(false);
    expect(isStandInOriginal(original({ standInRole: "smaller" }))).toBe(false);
    expect(isStandInOriginal(original({ type: "document/pdf" }))).toBe(false);
  });
});

describe("standInSlot", () => {
  it("names the canonical slot once per original", () => {
    expect(standInSlot({ parentId: "p", standInRole: "canonical", fidelity: 4272 })).toBe("canonical");
  });
  it("names a smaller stand-in's slot by its fidelity", () => {
    expect(standInSlot({ parentId: "p", standInRole: "smaller", fidelity: 640 })).toBe("640");
  });
  it("is null for a tombstone, an ordinary record and a derived record", () => {
    expect(standInSlot({ parentId: "p", standInRole: "smaller", fidelity: 640, deletedAt: "x" })).toBeNull();
    expect(standInSlot({ parentId: null, standInRole: null, fidelity: 6000 })).toBeNull();
    expect(standInSlot({ parentId: "p", standInRole: null, fidelity: null })).toBeNull();
  });
});

describe("checkStandInWrite", () => {
  function check(over: Partial<Parameters<typeof checkStandInWrite>[0]> = {}) {
    return checkStandInWrite(
      {
        type: "image/avif",
        role: "smaller",
        fidelity: 640,
        parent: original(),
        parentIdGiven: true,
        existingCanonical: null,
        ...over,
      },
      STD,
    );
  }
  const codes = (v: ReturnType<typeof check>) => v.refusals.map((r) => r.code);

  it("accepts a smaller stand-in at a standard size", () => {
    expect(check().refusals).toEqual([]);
  });

  it("accepts a canonical stand-in at the threshold", () => {
    expect(check({ role: "canonical", fidelity: 4272 }).refusals).toEqual([]);
  });

  it("refuses an unknown role and a non-integer fidelity", () => {
    expect(codes(check({ role: "huge", fidelity: 1.5 }))).toEqual(["invalid-role", "invalid-fidelity"]);
  });

  it("requires a parent", () => {
    expect(codes(check({ parentIdGiven: false, parent: null }))).toEqual(["parent-required"]);
  });

  it("answers 404 for a missing or deleted parent", () => {
    const missing = check({ parent: null });
    expect(codes(missing)).toEqual(["parent-not-found"]);
    expect(missing.refusals[0]!.status).toBe(404);
    expect(codes(check({ parent: original({ deletedAt: "t" }) }))).toEqual(["parent-not-found"]);
  });

  it("refuses a stand-in whose parent is itself a stand-in", () => {
    expect(codes(check({ parent: original({ standInRole: "canonical", parentId: "o" }) }))).toEqual([
      "parent-is-stand-in",
    ]);
  });

  it("refuses a stand-in for a derived record", () => {
    expect(codes(check({ parent: original({ parentId: "o" }) }))).toEqual(["parent-is-derived"]);
  });

  it("refuses a stand-in for a record outside the stand-in categories", () => {
    expect(codes(check({ parent: original({ type: "document/pdf" }) }))).toEqual([
      "parent-not-stand-in-category",
    ]);
  });

  it("refuses a disallowed format, such as HEIC or JPEG for an image", () => {
    expect(codes(check({ type: "image/heic" }))).toEqual(["type-not-allowed"]);
    expect(codes(check({ type: "image/jpeg" }))).toEqual(["type-not-allowed"]);
  });

  it("requires the parent's fidelity, and records a reported one", () => {
    expect(codes(check({ parent: original({ fidelity: null }) }))).toEqual(["parent-fidelity-unknown"]);
    const v = check({ parent: original({ fidelity: null }), reportedParentFidelity: 6000 });
    expect(v.refusals).toEqual([]);
    expect(v.recordParentFidelity).toBe(6000);
  });

  it("does not record a reported fidelity the parent already carries", () => {
    const v = check({ reportedParentFidelity: 6000 });
    expect(v.refusals).toEqual([]);
    expect(v.recordParentFidelity).toBeNull();
  });

  it("answers 409 for a reported fidelity that disagrees with the recorded one", () => {
    const v = check({ reportedParentFidelity: 5000 });
    expect(codes(v)).toEqual(["parent-fidelity-mismatch"]);
    expect(v.refusals[0]!.status).toBe(409);
  });

  it("refuses a canonical stand-in for a self-canonical original", () => {
    const v = check({ role: "canonical", fidelity: 3000, parent: original({ fidelity: 3000 }) });
    expect(codes(v)).toEqual(["original-takes-no-canonical"]);
    expect(v.refusals[0]!.status).toBe(409);
  });

  it("refuses a canonical stand-in at the wrong fidelity", () => {
    expect(codes(check({ role: "canonical", fidelity: 4000 }))).toEqual(["canonical-fidelity-wrong"]);
  });

  it("takes a video canonical stand-in at the original's own bitrate below the threshold", () => {
    const parent = original({ type: "video/mp4", fidelity: 3000 });
    expect(check({ type: "video/webm", role: "canonical", fidelity: 3000, parent }).refusals).toEqual([]);
    expect(codes(check({ type: "video/webm", role: "canonical", fidelity: 4800, parent }))).toEqual([
      "canonical-fidelity-wrong",
    ]);
  });

  it("takes a video canonical stand-in for a video below the size floor", () => {
    const parent = original({ type: "video/mp4", fidelity: 4800, sizeBytes: SMALL });
    expect(check({ type: "video/webm", role: "canonical", fidelity: 4800, parent }).refusals).toEqual([]);
  });

  it("marks the original self-canonical for a canonical stand-in no smaller than it", () => {
    const parent = original({ type: "video/mp4", fidelity: 3000 });
    const at = (sizeBytes: number) =>
      check({ type: "video/webm", role: "canonical", fidelity: 3000, parent, sizeBytes });
    expect(at(BIG)).toMatchObject({ refusals: [], selfCanonical: true });
    expect(at(BIG + 1)).toMatchObject({ refusals: [], selfCanonical: true });
    expect(at(BIG - 1)).toMatchObject({ refusals: [], selfCanonical: false });
  });

  it("replaces an outdated canonical stand-in, and refuses one that already matches", () => {
    const parent = original({ canonicalThreshold: 2560 });
    const replacing = check({
      role: "canonical",
      fidelity: 2560,
      parent,
      existingCanonical: { id: "old", fidelity: 4272 },
    });
    expect(replacing).toMatchObject({ refusals: [], replacesCanonical: "old", selfCanonical: false });
    const repeat = check({
      role: "canonical",
      fidelity: 2560,
      parent,
      existingCanonical: { id: "same", fidelity: 2560 },
    });
    expect(codes(repeat)).toEqual(["canonical-matches"]);
  });

  it("judges a parent whose fidelity this write records by the stamp it will carry", () => {
    const parent = original({ fidelity: null });
    const v = check({
      role: "canonical",
      fidelity: 2560,
      parent,
      reportedParentFidelity: 6000,
      parentStamp: 2560,
    });
    expect(v).toMatchObject({ refusals: [], recordParentFidelity: 6000 });
  });

  it("offers a stamped original only the standard sizes below its stamp", () => {
    const parent = original({ canonicalThreshold: 2000 });
    expect(codes(check({ fidelity: 2560, parent }))).toEqual(["not-a-standard-size", "exceeds-canonical"]);
    expect(check({ fidelity: 1280, parent }).refusals).toEqual([]);
  });

  it("refuses a smaller stand-in off the standard sizes", () => {
    expect(codes(check({ fidelity: 512 }))).toEqual(["not-a-standard-size"]);
  });

  it("refuses a smaller stand-in at or above the canonical stand-in", () => {
    const parent = original({ type: "video/mp4", fidelity: 2000 });
    // 2000 is a standard video size, but the canonical stand-in sits at 2000.
    expect(codes(check({ type: "video/webm", fidelity: 2000, parent }))).toEqual(["exceeds-canonical"]);
  });

  it("takes a smaller video stand-in only below the original's own bitrate", () => {
    const above = original({ type: "video/mp4", fidelity: 12000 });
    expect(check({ type: "video/webm", fidelity: 2000, parent: above }).refusals).toEqual([]);
    const below = original({ type: "video/mp4", fidelity: 1500 });
    expect(codes(check({ type: "video/webm", fidelity: 2000, parent: below }))).toEqual(["exceeds-canonical"]);
  });

  it("measures a smaller stand-in against an existing canonical stand-in", () => {
    const v = check({ fidelity: 2560, existingCanonical: { id: "c", fidelity: 2000 } });
    expect(codes(v)).toEqual(["exceeds-canonical"]);
  });

  it("refuses a smaller stand-in at or above a self-canonical original's own fidelity", () => {
    const parent = original({ fidelity: 2000 });
    expect(check({ fidelity: 1280, parent }).refusals).toEqual([]);
    expect(codes(check({ fidelity: 2560, parent }))).toEqual(["exceeds-canonical"]);
  });
});

describe("checkOriginalFidelity", () => {
  it("accepts a positive integer on an original in a stand-in category", () => {
    expect(checkOriginalFidelity({ type: "image/jpeg", parentId: null, fidelity: 4000 })).toEqual([]);
  });
  it("accepts an absent fidelity anywhere", () => {
    expect(checkOriginalFidelity({ type: "document/pdf", parentId: "p", fidelity: undefined })).toEqual([]);
  });
  it("refuses a fidelity on a derived record", () => {
    expect(checkOriginalFidelity({ type: "image/jpeg", parentId: "p", fidelity: 640 })[0]!.code).toBe(
      "fidelity-on-derived-record",
    );
  });
  it("refuses a fidelity outside the stand-in categories", () => {
    expect(checkOriginalFidelity({ type: "document/pdf", parentId: null, fidelity: 5 })[0]!.code).toBe(
      "fidelity-outside-stand-in-category",
    );
  });
  it("refuses a malformed fidelity", () => {
    expect(checkOriginalFidelity({ type: "image/jpeg", parentId: null, fidelity: "big" })[0]!.code).toBe(
      "invalid-fidelity",
    );
  });
});

describe("summarizeStandIns", () => {
  const here = () => "here" as const;

  it("lists every standard size and the canonical stand-in for an archivable original", () => {
    const summary = summarizeStandIns(
      original(),
      [standIn("smaller", 640), standIn("canonical", 4272)],
      STD,
      (r) => (r.id === "si-canonical-4272" ? "cloud" : "here"),
    )!;
    expect(summary.status).toBe("archivable");
    expect(summary.top).toBe(4272);
    expect(summary.sizes.map((s) => [s.fidelity, s.role, s.placement])).toEqual([
      [320, "smaller", "missing"],
      [640, "smaller", "here"],
      [1280, "smaller", "missing"],
      [2560, "smaller", "missing"],
      [4272, "canonical", "cloud"],
    ]);
  });

  it("marks a canonical stand-in made for another threshold as outdated, and still serves it", () => {
    const summary = summarizeStandIns(
      original({ canonicalThreshold: 2560 }),
      [standIn("smaller", 640), standIn("canonical", 4272)],
      STD,
      here,
    )!;
    expect(summary).toMatchObject({ top: 4272, canonicalTarget: 2560, canonicalOutdated: true });
    const current = summarizeStandIns(original(), [standIn("canonical", 4272)], STD, here)!;
    expect(current).toMatchObject({ canonicalTarget: 4272, canonicalOutdated: false });
  });

  it("says where the original's own bytes sit", () => {
    const o = original();
    const onlyStandInsHere = (r: { id: string }) => (r.id === o.id ? "cloud" : "here");
    expect(summarizeStandIns(o, [], STD, onlyStandInsHere)!.originalPlacement).toBe("cloud");
    expect(summarizeStandIns(o, [], STD, here)!.originalPlacement).toBe("here");
  });

  it("lists a missing canonical stand-in at the expected fidelity", () => {
    const summary = summarizeStandIns(original(), [], STD, here)!;
    expect(summary.sizes.at(-1)).toMatchObject({ fidelity: 4272, role: "canonical", placement: "missing" });
  });

  it("lets a self-canonical original answer its own top size", () => {
    const o = original({ fidelity: 2000 });
    const summary = summarizeStandIns(o, [standIn("smaller", 320)], STD, here)!;
    expect(summary.sizes.map((s) => [s.fidelity, s.role, s.placement])).toEqual([
      [320, "smaller", "here"],
      [640, "smaller", "missing"],
      [1280, "smaller", "missing"],
      [2000, "original", "here"],
    ]);
    expect(summary.sizes.at(-1)!.recordId).toBe("orig");
  });

  it("lists only what exists for an original with no fidelity", () => {
    const summary = summarizeStandIns(original({ fidelity: null }), [standIn("smaller", 320)], STD, here)!;
    expect(summary.status).toBe("fidelity-unknown");
    expect(summary.top).toBeNull();
    expect(summary.sizes.map((s) => s.fidelity)).toEqual([320]);
  });

  it("ignores tombstoned stand-ins", () => {
    const summary = summarizeStandIns(original(), [standIn("smaller", 640, { deletedAt: "t" })], STD, here)!;
    expect(summary.sizes.find((s) => s.fidelity === 640)!.placement).toBe("missing");
  });

  it("is null for a derived record or a record outside the stand-in categories", () => {
    expect(summarizeStandIns(original({ parentId: "x" }), [], STD, here)).toBeNull();
    expect(summarizeStandIns(original({ type: "document/pdf" }), [], STD, here)).toBeNull();
  });
});

describe("resolveSize", () => {
  const summary = summarizeStandIns(
    original(),
    [standIn("smaller", 640), standIn("canonical", 4272)],
    STD,
    () => "here",
  )!;

  it("serves the stand-in at an exact standard size", () => {
    expect(resolveSize(summary, 640, STD)).toMatchObject({ kind: "serve", size: { fidelity: 640 } });
  });

  it("reports a standard size nobody has produced", () => {
    expect(resolveSize(summary, 1280, STD)).toEqual({ kind: "not-produced", fidelity: 1280 });
  });

  it("serves the canonical stand-in for canonical and for any larger size", () => {
    expect(resolveSize(summary, "canonical", STD)).toMatchObject({ kind: "serve", size: { role: "canonical" } });
    expect(resolveSize(summary, 8000, STD)).toMatchObject({ kind: "serve", size: { role: "canonical" } });
  });

  it("refuses a size between standard sizes", () => {
    expect(resolveSize(summary, 500, STD).kind).toBe("not-standard");
  });

  it("serves a self-canonical original for canonical", () => {
    const own = summarizeStandIns(original({ fidelity: 2000 }), [], STD, () => "here")!;
    expect(resolveSize(own, "canonical", STD)).toMatchObject({ kind: "serve", size: { role: "original" } });
  });

  it("cannot resolve an original with no fidelity", () => {
    const unknown = summarizeStandIns(original({ fidelity: null }), [], STD, () => "here")!;
    expect(resolveSize(unknown, 640, STD)).toEqual({ kind: "unknown-fidelity" });
  });
});

describe("ceilingPlacement", () => {
  const desktop = DEFAULT_SYNC_DOWN_CEILINGS.desktop;
  const phone = DEFAULT_SYNC_DOWN_CEILINGS.phone;
  const place = (over: Partial<StandInFacts>, ceilings = desktop) =>
    ceilingPlacement({ ...original(), ...over }, ceilings, STD);

  it("receives stand-ins at or below the ceiling and not above", () => {
    expect(place({ parentId: "o", standInRole: "smaller", fidelity: 2560 })).toBe("within");
    expect(place({ parentId: "o", standInRole: "smaller", fidelity: 2560 }, phone)).toBe("above");
    expect(place({ parentId: "o", standInRole: "canonical", fidelity: 4272 })).toBe("above");
  });

  it("treats a self-canonical original as a stand-in at its own fidelity", () => {
    expect(place({ fidelity: 2000 })).toBe("within");
    expect(place({ fidelity: 2000 }, phone)).toBe("above");
  });

  it("puts archivable originals and unknown fidelity above every ceiling", () => {
    expect(place({ fidelity: 6000 })).toBe("above");
    expect(place({ fidelity: null })).toBe("above");
    expect(place({ fidelity: null, sizeBytes: SMALL })).toBe("above");
  });

  it("puts every video stand-in above a ceiling of none", () => {
    expect(place({ type: "video/webm", parentId: "o", standInRole: "smaller", fidelity: 2000 })).toBe("above");
    expect(place({ type: "video/mp4", fidelity: 2000 })).toBe("above");
  });

  // No stand-in can replace either, so every node keeps both.
  it("keeps derived records and types without stand-in standards", () => {
    expect(place({ parentId: "o" })).toBe("keep");
    expect(place({ type: "document/pdf" })).toBe("keep");
  });
});
