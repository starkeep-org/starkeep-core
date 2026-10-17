import { describe, it, expect } from "vitest";
import {
  dataRecordObjectKey,
  appSyncableObjectKey,
  appSyncableObjectPrefix,
  categoryFromSharedObjectKey,
  contentHashFromDataRecordObjectKey,
  LOCAL_USER_SEGMENT,
  rebindObjectKey,
  sharedObjectPrefix,
  userIdFromObjectKey,
} from "../src/storage/object-keys.js";

const USER = "6c1e0a7e-1111-4222-8333-944455556666";
const hash = "abcd1234".padEnd(64, "0");

describe("contentHashFromDataRecordObjectKey", () => {
  it("round-trips a key built by dataRecordObjectKey", () => {
    for (const type of ["image/jpeg", "video/mp4", "other/other"]) {
      expect(contentHashFromDataRecordObjectKey(dataRecordObjectKey(USER, type, hash))).toBe(hash);
    }
  });

  // The recovered hash becomes the checksum pinned into a presigned PUT, which
  // decides which bytes may be written at that key. Every rejection below is a
  // case where trusting the key would let something other than a Starkeep
  // content-addressed blob dictate that pin.
  it.each([
    ["a shard that disagrees with the hash", `shared/${USER}/image/zz/${hash}`],
    ["a non-shared namespace", `apps/photos/${USER}/syncable/${hash}`],
    ["a hash that isn't 64 hex chars", `shared/${USER}/image/ab/not-a-hash`],
    ["uppercase hex", `shared/${USER}/image/AB/${hash.toUpperCase()}`],
    ["the old layout with no user segment", `shared/image/ab/${hash}`],
    ["too many segments", `shared/${USER}/image/ab/extra/${hash}`],
    ["a user segment that walks a path", `shared/../image/ab/${hash}`],
    ["empty", ""],
  ])("returns null for %s", (_label, key) => {
    expect(contentHashFromDataRecordObjectKey(key)).toBeNull();
  });

  it("returns null for app-syncable keys, which are deliberately not content-addressed", () => {
    expect(
      contentHashFromDataRecordObjectKey(appSyncableObjectKey("photos", USER, "covers/a.json")),
    ).toBeNull();
  });
});

describe("dataRecordObjectKey", () => {
  it("places data record blobs under shared/<userId>/<category>/<shard>/<hash>", () => {
    expect(dataRecordObjectKey(USER, "image/jpeg", hash)).toBe(`shared/${USER}/image/ab/${hash}`);
    expect(dataRecordObjectKey(USER, "document/markdown", hash)).toBe(`shared/${USER}/document/ab/${hash}`);
  });

  it("buckets other-typed or malformed types under the user's other prefix", () => {
    expect(dataRecordObjectKey(USER, "other/other", hash)).toBe(`shared/${USER}/other/ab/${hash}`);
    expect(dataRecordObjectKey(USER, "", hash)).toBe(`shared/${USER}/other/ab/${hash}`);
  });

  it("writes an unbound library's keys under the local segment", () => {
    expect(dataRecordObjectKey(LOCAL_USER_SEGMENT, "image/jpeg", hash)).toBe(`shared/local/image/ab/${hash}`);
  });

  it("refuses a user segment that is not one", () => {
    expect(() => dataRecordObjectKey("../x", "image/jpeg", hash)).toThrow(/invalid user segment/);
    expect(() => dataRecordObjectKey("", "image/jpeg", hash)).toThrow(/invalid user segment/);
  });

  it("does not include any app identifier in the key", () => {
    expect(dataRecordObjectKey(USER, "text/txt", "f".repeat(64))).not.toMatch(/apps\//);
  });
});

describe("appSyncableObjectKey", () => {
  it("prefixes a relative subKey with apps/<appId>/<userId>/syncable/", () => {
    expect(appSyncableObjectKey("photos", USER, "style-graphic")).toBe(`apps/photos/${USER}/syncable/style-graphic`);
    expect(appSyncableObjectPrefix("photos", USER)).toBe(`apps/photos/${USER}/syncable/`);
  });

  it("is idempotent when the key is already prefixed for the same app and user", () => {
    const already = `apps/photos/${USER}/syncable/cache/x`;
    expect(appSyncableObjectKey("photos", USER, already)).toBe(already);
  });

  it("rejects keys that escape the namespace", () => {
    expect(() => appSyncableObjectKey("photos", USER, "/abs")).toThrow();
    expect(() => appSyncableObjectKey("photos", USER, "a/../b")).toThrow();
    expect(() => appSyncableObjectKey("pho/tos", USER, "a")).toThrow();
    expect(() => appSyncableObjectKey("photos", "a/b", "a")).toThrow();
  });
});

describe("the user segment", () => {
  it("is read from either namespace, and not from anything else", () => {
    expect(userIdFromObjectKey(dataRecordObjectKey(USER, "image/jpeg", hash))).toBe(USER);
    expect(userIdFromObjectKey(appSyncableObjectKey("memo", USER, "media/a.mp3"))).toBe(USER);
    expect(userIdFromObjectKey(`apps/memo/.keep`)).toBeNull();
    expect(userIdFromObjectKey(`_starkeep/inventory/x`)).toBeNull();
    expect(userIdFromObjectKey(`shared/`)).toBeNull();
  });

  it("names the category of a shared key", () => {
    expect(categoryFromSharedObjectKey(dataRecordObjectKey(USER, "video/mp4", hash))).toBe("video");
    expect(categoryFromSharedObjectKey(appSyncableObjectKey("memo", USER, "a"))).toBeNull();
  });

  it("is renamed by binding, in both namespaces, and nothing else changes", () => {
    const shared = dataRecordObjectKey(LOCAL_USER_SEGMENT, "image/jpeg", hash);
    expect(rebindObjectKey(shared, USER)).toBe(dataRecordObjectKey(USER, "image/jpeg", hash));
    const app = appSyncableObjectKey("memo", LOCAL_USER_SEGMENT, "media/a.mp3");
    expect(rebindObjectKey(app, USER)).toBe(appSyncableObjectKey("memo", USER, "media/a.mp3"));
    expect(rebindObjectKey("apps/memo/.keep", USER)).toBe("apps/memo/.keep");
    expect(sharedObjectPrefix(USER)).toBe(`shared/${USER}/`);
  });
});
