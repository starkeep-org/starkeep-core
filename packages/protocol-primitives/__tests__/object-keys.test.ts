import { describe, it, expect } from "vitest";
import {
  dataRecordObjectKey,
  appSyncableObjectKey,
} from "../src/storage/object-keys.js";

describe("dataRecordObjectKey", () => {
  it("places data record blobs under shared/<category>/<shard>/<hash>", () => {
    const hash = "abcd1234".padEnd(64, "0");
    // The key is bucketed by the derived category, not the raw extension.
    expect(dataRecordObjectKey("jpg", hash)).toBe(
      `shared/image/ab/${hash}`,
    );
    expect(dataRecordObjectKey("md", hash)).toBe(
      `shared/document/ab/${hash}`,
    );
  });

  it("buckets unmapped or extension-less files under shared/other", () => {
    const hash = "abcd1234".padEnd(64, "0");
    expect(dataRecordObjectKey("xyz", hash)).toBe(`shared/other/ab/${hash}`);
    expect(dataRecordObjectKey("", hash)).toBe(`shared/other/ab/${hash}`);
  });

  it("does not include any app identifier in the key", () => {
    const hash = "f".repeat(64);
    const key = dataRecordObjectKey("txt", hash);
    expect(key).not.toMatch(/apps\//);
  });

  it("produces deterministic keys for the same type+hash", () => {
    const hash = "1".repeat(64);
    expect(dataRecordObjectKey("md", hash)).toBe(
      dataRecordObjectKey("md", hash),
    );
  });
});

describe("appSyncableObjectKey", () => {
  it("prefixes a relative subKey with apps/<appId>/syncable/", () => {
    expect(appSyncableObjectKey("photos", "style-graphic")).toBe(
      "apps/photos/syncable/style-graphic",
    );
  });

  it("is idempotent when the key is already prefixed", () => {
    const already = "apps/photos/syncable/cache/x";
    expect(appSyncableObjectKey("photos", already)).toBe(already);
  });

  it("rejects subKeys that start with /", () => {
    expect(() => appSyncableObjectKey("photos", "/leading-slash")).toThrow();
  });

  it("rejects subKeys with .. segments", () => {
    expect(() => appSyncableObjectKey("photos", "../escape")).toThrow();
    expect(() => appSyncableObjectKey("photos", "foo/../bar")).toThrow();
  });

  it("rejects invalid appIds", () => {
    expect(() => appSyncableObjectKey("", "x")).toThrow();
    expect(() => appSyncableObjectKey("bad/id", "x")).toThrow();
  });
});
