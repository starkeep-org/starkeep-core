/**
 * Content-addressed record ids.
 *
 * The property under test is convergence: two nodes that produce the same file
 * must produce the same id, because that is what turns a uniqueness collision
 * during sync into an ordinary LWW merge. Everything else here guards the ways
 * that property could be lost quietly.
 */

import { describe, it, expect } from "vitest";
import {
  contentAddressedId,
  isContentAddressedId,
  CONTENT_ID_PREFIX,
  generateId,
  isStarkeepId,
  createDataRecord,
  createHLCClock,
} from "../src/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** The ULID alphabet, which these ids share so every existing column fits them. */
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("contentAddressedId", () => {
  it("is the same on every node for the same file", () => {
    expect(contentAddressedId("sunset.png", HASH_A)).toBe(
      contentAddressedId("sunset.png", HASH_A),
    );
  });

  it("fits everywhere a ULID fits", () => {
    const id = contentAddressedId("sunset.png", HASH_A);
    expect(id).toHaveLength(26);
    expect(id).toMatch(CROCKFORD);
    expect(isStarkeepId(id)).toBe(true);
  });

  it("separates on both inputs, so either one changing changes the id", () => {
    const base = contentAddressedId("sunset.png", HASH_A);
    expect(contentAddressedId("sunrise.png", HASH_A)).not.toBe(base);
    expect(contentAddressedId("sunset.png", HASH_B)).not.toBe(base);
  });

  it("cannot be confused by where the filename ends", () => {
    // Without a separator the two inputs concatenate to the same string, and
    // two genuinely different records would collapse into one row.
    expect(contentAddressedId("ab", "c")).not.toBe(contentAddressedId("a", "bc"));
  });

  it("is distinguishable from a ULID, and sorts after every one", () => {
    const id = contentAddressedId("sunset.png", HASH_A);
    expect(isContentAddressedId(id)).toBe(true);

    // A ULID's first character encodes the top bits of a 48-bit millisecond
    // timestamp, so it cannot reach `Z`. That is what makes the discriminator
    // sound rather than conventional, and what keeps existing records ordered
    // ahead of these instead of interleaved with them.
    const ulid = generateId();
    expect(isContentAddressedId(ulid)).toBe(false);
    expect(id > ulid).toBe(true);
    expect(CONTENT_ID_PREFIX > ulid[0]!).toBe(true);
  });

  it("does not claim a short string that happens to start with the prefix", () => {
    expect(isContentAddressedId("Z")).toBe(false);
    expect(isContentAddressedId(`${CONTENT_ID_PREFIX}${"0".repeat(24)}`)).toBe(false);
  });
});

describe("createDataRecord ids", () => {
  const input = {
    type: "image/png",
    originAppId: "photos",
    contentHash: HASH_A,
    objectStorageKey: `shared/image/aa/${HASH_A}`,
    sizeBytes: 10,
  };

  it("converges for a named record, across independent clocks", () => {
    // Two clocks stand in for two nodes: the record's identity must not depend
    // on when or where it was written.
    const a = createDataRecord({ ...input, originalFilename: "sunset.png" }, createHLCClock({ nodeId: "node-a" }));
    const b = createDataRecord({ ...input, originalFilename: "sunset.png" }, createHLCClock({ nodeId: "node-b" }));
    expect(a.id).toBe(b.id);
    expect(isContentAddressedId(a.id)).toBe(true);
  });

  it("still separates records the uniqueness index separates", () => {
    const clock = createHLCClock({ nodeId: "node-a" });
    const one = createDataRecord({ ...input, originalFilename: "sunset.png" }, clock);
    const other = createDataRecord({ ...input, originalFilename: "sunrise.png" }, clock);
    expect(one.id).not.toBe(other.id);
  });

  it("keeps a minted id when there is no filename to constrain", () => {
    // The uniqueness index is partial — `WHERE original_filename IS NOT NULL` —
    // so an unnamed record is not constrained and has nothing to converge on.
    // Two such records must stay distinct rather than collapsing on their bytes.
    const clock = createHLCClock({ nodeId: "node-a" });
    const one = createDataRecord(input, clock);
    const other = createDataRecord(input, clock);
    expect(isContentAddressedId(one.id)).toBe(false);
    expect(one.id).not.toBe(other.id);
  });
});
