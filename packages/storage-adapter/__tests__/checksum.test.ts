import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { sha256HexToBase64, sha256Base64ToHex } from "../src/object-storage/checksum.js";

const bytes = Buffer.from("the bytes this key names");
const hex = createHash("sha256").update(bytes as unknown as Uint8Array).digest("hex");
const base64 = createHash("sha256").update(bytes as unknown as Uint8Array).digest("base64");

describe("sha256HexToBase64", () => {
  it("converts a hex digest to the base64 form S3 checksum headers take", () => {
    expect(sha256HexToBase64(hex)).toBe(base64);
  });

  it("round-trips", () => {
    expect(sha256Base64ToHex(sha256HexToBase64(hex))).toBe(hex);
  });

  // This value is signed into a presigned PUT and decides which bytes may be
  // written at a key. A silently-wrong conversion would defeat exactly the
  // verification it exists to provide, so malformed input must throw rather
  // than produce a plausible-looking string.
  it.each([
    ["uppercase hex", hex.toUpperCase()],
    ["too short", hex.slice(0, 63)],
    ["too long", hex + "0"],
    ["already base64", base64],
    ["empty", ""],
  ])("throws on %s rather than producing a wrong pin", (_label, input) => {
    expect(() => sha256HexToBase64(input)).toThrow(/expected a 64-character lowercase hex/);
  });
});

describe("sha256Base64ToHex", () => {
  // The single most dangerous confusion available here: a multipart object's
  // stored checksum is a digest *over the part digests*, suffixed `-<parts>`.
  // Comparing it to a contentHash would report a mismatch on a perfectly good
  // object — or, with a sloppier parse, report a match on a bad one.
  it("returns null for a multipart composite checksum instead of decoding it", () => {
    expect(sha256Base64ToHex(`${base64}-4`)).toBeNull();
  });

  it("returns null for anything that isn't 32 decoded bytes", () => {
    expect(sha256Base64ToHex(Buffer.from("short").toString("base64"))).toBeNull();
    expect(sha256Base64ToHex("")).toBeNull();
  });
});
