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
  type StarkeepId,
} from "../src/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const PARENT_A = "01J000000000000000000000A0" as StarkeepId;
const PARENT_B = "01J000000000000000000000B0" as StarkeepId;

/** The ULID alphabet, which these ids share so every existing column fits them. */
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("contentAddressedId", () => {
  it("is the same on every node for the same file", () => {
    expect(contentAddressedId(null, "sunset.png", HASH_A)).toBe(
      contentAddressedId(null, "sunset.png", HASH_A),
    );
  });

  it("fits everywhere a ULID fits", () => {
    const id = contentAddressedId(null, "sunset.png", HASH_A);
    expect(id).toHaveLength(26);
    expect(id).toMatch(CROCKFORD);
    expect(isStarkeepId(id)).toBe(true);
  });

  it("separates on every input, so any one changing changes the id", () => {
    const base = contentAddressedId(PARENT_A, "sunset.png", HASH_A);
    expect(contentAddressedId(PARENT_B, "sunset.png", HASH_A)).not.toBe(base);
    expect(contentAddressedId(PARENT_A, "sunrise.png", HASH_A)).not.toBe(base);
    expect(contentAddressedId(PARENT_A, "sunset.png", HASH_B)).not.toBe(base);
  });

  it("cannot be confused by where one field ends and the next begins", () => {
    // Without a separator the inputs concatenate to the same string, and two
    // genuinely different records would collapse into one row.
    expect(contentAddressedId(null, "ab", "c")).not.toBe(
      contentAddressedId(null, "a", "bc"),
    );
    expect(contentAddressedId("ab" as StarkeepId, "c", HASH_A)).not.toBe(
      contentAddressedId("a" as StarkeepId, "bc", HASH_A),
    );
  });

  it("gives a top-level record the id it had before parentage joined the key", () => {
    // The whole reason a null parent takes the two-field form: every existing
    // top-level row keeps its id, so nothing re-mints on upgrade and no node
    // collides with its own history. A three-field form over an empty parent
    // would have re-keyed every record already stored.
    const twoField = contentAddressedId(null, "sunset.png", HASH_A);
    const emptyParent = contentAddressedId("" as StarkeepId, "sunset.png", HASH_A);
    expect(twoField).not.toBe(emptyParent);
  });

  it("treats a missing filename as a value rather than as a reason to differ", () => {
    // Both indexes cover nameless rows — SQLite through COALESCE, DSQL through
    // NULLS NOT DISTINCT — so two nodes producing one nameless file under one
    // parent have to agree on the row.
    expect(contentAddressedId(PARENT_A, null, HASH_A)).toBe(
      contentAddressedId(PARENT_A, null, HASH_A),
    );
    expect(contentAddressedId(PARENT_A, null, HASH_A)).not.toBe(
      contentAddressedId(PARENT_B, null, HASH_A),
    );
  });

  it("is distinguishable from a ULID, and sorts after every one", () => {
    const id = contentAddressedId(null, "sunset.png", HASH_A);
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

  /** Two clocks stand in for two nodes deriving the same file independently. */
  const nodeA = () => createHLCClock({ nodeId: "node-a" });
  const nodeB = () => createHLCClock({ nodeId: "node-b" });

  it("converges for a named record, across independent clocks", () => {
    // The record's identity must not depend on when or where it was written.
    const a = createDataRecord({ ...input, originalFilename: "sunset.png" }, nodeA());
    const b = createDataRecord({ ...input, originalFilename: "sunset.png" }, nodeB());
    expect(a.id).toBe(b.id);
    expect(isContentAddressedId(a.id)).toBe(true);
  });

  it("converges for a nameless record too", () => {
    const a = createDataRecord(input, nodeA());
    const b = createDataRecord(input, nodeB());
    expect(a.id).toBe(b.id);
    expect(isContentAddressedId(a.id)).toBe(true);
  });

  it("still separates records the uniqueness index separates", () => {
    const clock = nodeA();
    const one = createDataRecord({ ...input, originalFilename: "sunset.png" }, clock);
    const other = createDataRecord({ ...input, originalFilename: "sunrise.png" }, clock);
    expect(one.id).not.toBe(other.id);
  });

  it("keeps two originals' identical renditions apart", () => {
    // The case parentage is in the key for. Two copies of one photo under
    // different names are two legal records; a rendition named after the
    // parent's *filename* collides whenever two parents share a name, and
    // stripping EXIF makes the derived bytes identical. Without the parent in
    // the key these are one row, and the second registration silently takes the
    // first original's rendition away.
    const clock = nodeA();
    const fromA = createDataRecord(
      { ...input, originalFilename: "thumb_x.jpg", parentId: PARENT_A },
      clock,
    );
    const fromB = createDataRecord(
      { ...input, originalFilename: "thumb_x.jpg", parentId: PARENT_B },
      clock,
    );
    expect(fromA.id).not.toBe(fromB.id);
    expect(fromA.parentId).toBe(PARENT_A);
    expect(fromB.parentId).toBe(PARENT_B);
  });

  it("still converges when two nodes derive one rendition from one parent", () => {
    // The case the whole scheme exists for, now one level down: the child id is
    // agreed only because the parent id is.
    const a = createDataRecord(
      { ...input, originalFilename: "thumb_x.jpg", parentId: PARENT_A },
      nodeA(),
    );
    const b = createDataRecord(
      { ...input, originalFilename: "thumb_x.jpg", parentId: PARENT_A },
      nodeB(),
    );
    expect(a.id).toBe(b.id);
  });

  it("keeps a top-level record's id independent of the child form", () => {
    const clock = nodeA();
    const top = createDataRecord({ ...input, originalFilename: "sunset.png" }, clock);
    expect(top.id).toBe(contentAddressedId(null, "sunset.png", HASH_A));
  });
});
