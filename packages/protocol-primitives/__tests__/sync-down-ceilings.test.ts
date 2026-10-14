import { describe, expect, it } from "vitest";
import {
  ceilingChoices,
  DEFAULT_STAND_IN_STANDARDS,
  DEFAULT_SYNC_DOWN_CEILINGS,
  resolveSyncDownCeilings,
  syncDownCeilingProblems,
} from "../src/stand-ins/standards.js";

describe("syncDownCeilingProblems", () => {
  it("accepts a positive whole fidelity or null, per category", () => {
    expect(syncDownCeilingProblems({ image: 640, video: null })).toEqual([]);
    expect(syncDownCeilingProblems(undefined)).toEqual([]);
  });

  it("names an unknown category and a malformed ceiling", () => {
    const problems = syncDownCeilingProblems({ audio: 10, image: 0, video: 1.5 });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/audio is not a stand-in category/);
    expect(problems[1]).toMatch(/^image:/);
    expect(problems[2]).toMatch(/^video:/);
  });

  it("refuses a value that is not an object of ceilings", () => {
    expect(syncDownCeilingProblems([640])).toHaveLength(1);
    expect(syncDownCeilingProblems("640")).toHaveLength(1);
  });
});

describe("resolveSyncDownCeilings", () => {
  it("lays configured values over the node's defaults", () => {
    expect(resolveSyncDownCeilings({ video: 2000 }, DEFAULT_SYNC_DOWN_CEILINGS.phone)).toEqual({
      image: 1280,
      video: 2000,
    });
    expect(resolveSyncDownCeilings({ image: null }, DEFAULT_SYNC_DOWN_CEILINGS.desktop)).toEqual({
      image: null,
      video: null,
    });
  });

  it("keeps the default for a malformed value and reports it", () => {
    const ignored: string[] = [];
    const out = resolveSyncDownCeilings(
      { image: -1 },
      DEFAULT_SYNC_DOWN_CEILINGS.phone,
      (category) => ignored.push(category),
    );
    expect(out.image).toBe(1280);
    expect(ignored).toEqual(["image"]);
  });

  it("answers the defaults for nothing stored", () => {
    expect(resolveSyncDownCeilings(undefined, DEFAULT_SYNC_DOWN_CEILINGS.phone)).toEqual(
      DEFAULT_SYNC_DOWN_CEILINGS.phone,
    );
  });
});

describe("ceilingChoices", () => {
  it("offers the standard sizes and the canonical threshold, ascending", () => {
    const image = DEFAULT_STAND_IN_STANDARDS.image;
    expect(ceilingChoices(image)).toEqual(
      [...new Set([...image.standardSizes, image.canonicalThreshold])].sort((a, b) => a - b),
    );
  });

  it("keeps a current value the standards no longer list", () => {
    expect(ceilingChoices({ standardSizes: [320, 640], canonicalThreshold: 4000 }, 999)).toEqual([
      320, 640, 999, 4000,
    ]);
  });
});
