import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  MULTIPART_PART_BYTES,
  compositePartCount,
  compositeSha256Checksum,
  multipartPartCount,
  multipartPartSpan,
  partChecksumBase64,
} from "../src/object-storage/multipart.js";

const sha = (s: string) => createHash("sha256").update(s).digest();

describe("compositeSha256Checksum", () => {
  it("is S3's composite: base64 SHA-256 over the raw part digests, suffixed with the count", () => {
    const parts = [sha("part one"), sha("part two"), sha("part three")];
    const expected =
      createHash("sha256")
        .update(Buffer.concat(parts) as unknown as Uint8Array)
        .digest("base64") + "-3";
    expect(compositeSha256Checksum(parts.map((p) => p.toString("hex")))).toBe(expected);
  });

  it("refuses anything that is not a lowercase hex digest", () => {
    expect(() => compositeSha256Checksum(["ABC"])).toThrow(/lowercase hex/);
    expect(() => compositeSha256Checksum([])).toThrow(/at least one part/);
  });
});

describe("partChecksumBase64", () => {
  it("matches Buffer's base64 of the raw digest, for every padding length", () => {
    for (const s of ["a", "bb", "ccc", "the bytes"]) {
      const digest = sha(s);
      expect(partChecksumBase64(digest.toString("hex"))).toBe(digest.toString("base64"));
    }
  });
});

describe("compositePartCount", () => {
  it("reads the count from a composite and refuses a whole-object checksum", () => {
    const composite = compositeSha256Checksum([sha("x").toString("hex"), sha("y").toString("hex")]);
    expect(compositePartCount(composite)).toBe(2);
    expect(compositePartCount(sha("whole").toString("base64"))).toBeNull();
    expect(compositePartCount(`${sha("whole").toString("base64")}-0`)).toBeNull();
  });
});

describe("part arithmetic", () => {
  it("splits a file into full parts and a shorter last part", () => {
    const size = 2 * MULTIPART_PART_BYTES + 5;
    expect(multipartPartCount(size)).toBe(3);
    expect(multipartPartSpan(size, 1)).toEqual({ offset: 0, length: MULTIPART_PART_BYTES });
    expect(multipartPartSpan(size, 3)).toEqual({ offset: 2 * MULTIPART_PART_BYTES, length: 5 });
  });

  it("gives an exact multiple no empty trailing part", () => {
    expect(multipartPartCount(4 * MULTIPART_PART_BYTES)).toBe(4);
  });
});
