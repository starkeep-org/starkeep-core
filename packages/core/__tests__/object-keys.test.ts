import { describe, it, expect } from "vitest";
import {
  dataRecordObjectKey,
  appPrivateObjectKey,
  appPrivateHashedKey,
} from "../src/storage/object-keys.js";

describe("dataRecordObjectKey", () => {
  it("places data record blobs under shared/<typeId>/<shard>/<hash>", () => {
    const hash = "abcd1234".padEnd(64, "0");
    expect(dataRecordObjectKey("image-jpeg", hash)).toBe(
      `shared/image-jpeg/ab/${hash}`,
    );
  });

  it("does not include any app identifier in the key", () => {
    const hash = "f".repeat(64);
    const key = dataRecordObjectKey("text-note", hash);
    expect(key).not.toMatch(/apps\//);
  });

  it("produces deterministic keys for the same type+hash", () => {
    const hash = "1".repeat(64);
    expect(dataRecordObjectKey("markdown", hash)).toBe(
      dataRecordObjectKey("markdown", hash),
    );
  });
});

describe("appPrivateObjectKey", () => {
  it("prefixes a relative subKey with apps/<appId>/", () => {
    expect(appPrivateObjectKey("photos", "thumbs/abc.jpg")).toBe(
      "apps/photos/thumbs/abc.jpg",
    );
  });

  it("is idempotent when the key is already prefixed", () => {
    const already = "apps/photos/cache/x";
    expect(appPrivateObjectKey("photos", already)).toBe(already);
  });
});

describe("appPrivateHashedKey", () => {
  it("uses the 2-char shard layout under apps/<appId>/", () => {
    const hash = "deadbeef".padEnd(64, "0");
    expect(appPrivateHashedKey("photos", hash)).toBe(
      `apps/photos/de/${hash}`,
    );
  });
});
