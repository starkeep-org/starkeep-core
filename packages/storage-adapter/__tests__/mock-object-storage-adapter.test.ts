import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { MockObjectStorageAdapter } from "../src/mock/mock-object-storage-adapter.js";

describe("MockObjectStorageAdapter", () => {
  let adapter: MockObjectStorageAdapter;

  beforeEach(async () => {
    adapter = new MockObjectStorageAdapter();
    await adapter.init();
  });

  describe("lifecycle", () => {
    it("should report healthy after init", async () => {
      expect(await adapter.healthCheck()).toBe(true);
    });

    it("should report unhealthy after close", async () => {
      await adapter.close();
      expect(await adapter.healthCheck()).toBe(false);
    });
  });

  describe("put / get", () => {
    it("should store and retrieve data", async () => {
      const data = Buffer.from("hello world");
      await adapter.put("test-key", data, { contentType: "text/plain" });

      const result = await adapter.get("test-key");
      expect(result).not.toBeNull();
      expect(result!.data.toString()).toBe("hello world");
      expect(result!.contentType).toBe("text/plain");
      expect(result!.size).toBe(11);
    });

    it("should return null for non-existent key", async () => {
      expect(await adapter.get("missing")).toBeNull();
    });

    it("should handle Uint8Array input", async () => {
      const data = new Uint8Array([1, 2, 3, 4]);
      await adapter.put("binary", data);

      const result = await adapter.get("binary");
      expect(result).not.toBeNull();
      expect(result!.size).toBe(4);
    });

    it("should store metadata", async () => {
      await adapter.put("key", Buffer.from("data"), {
        metadata: { "x-custom": "value" },
      });

      const result = await adapter.get("key");
      expect(result!.metadata).toEqual({ "x-custom": "value" });
    });

    it("should return clones", async () => {
      await adapter.put("key", Buffer.from("data"));
      const a = await adapter.get("key");
      const b = await adapter.get("key");
      expect(a!.data).not.toBe(b!.data);
      expect(a!.data).toEqual(b!.data);
    });
  });

  describe("delete", () => {
    it("should remove an object", async () => {
      await adapter.put("key", Buffer.from("data"));
      await adapter.delete("key");
      expect(await adapter.get("key")).toBeNull();
    });
  });

  describe("list", () => {
    it("should list keys with prefix", async () => {
      await adapter.put("notes/a.jpg", Buffer.from(""));
      await adapter.put("notes/b.jpg", Buffer.from(""));
      await adapter.put("docs/c.txt", Buffer.from(""));

      const result = await adapter.list("notes/");
      expect(result.keys).toEqual(["notes/a.jpg", "notes/b.jpg"]);
      expect(result.hasMore).toBe(false);
    });

    it("should paginate with limit and cursor", async () => {
      await adapter.put("a", Buffer.from(""));
      await adapter.put("b", Buffer.from(""));
      await adapter.put("c", Buffer.from(""));

      const page1 = await adapter.list("", { limit: 2 });
      expect(page1.keys).toHaveLength(2);
      expect(page1.hasMore).toBe(true);

      const page2 = await adapter.list("", { limit: 2, cursor: page1.nextCursor! });
      expect(page2.keys).toHaveLength(1);
      expect(page2.hasMore).toBe(false);
    });

    it("should return sorted keys", async () => {
      await adapter.put("c", Buffer.from(""));
      await adapter.put("a", Buffer.from(""));
      await adapter.put("b", Buffer.from(""));

      const result = await adapter.list("");
      expect(result.keys).toEqual(["a", "b", "c"]);
    });
  });

  // The mock stands in for S3 in most unit tests, so it has to enforce the same
  // contract. If it accepted a wrong checksum, every test of the verified-upload
  // path would pass whether or not the checksum was ever sent — which is the one
  // thing those tests exist to catch.
  describe("checksum enforcement", () => {
    const data = Buffer.from("verified bytes");
    const digest = createHash("sha256").update(data as unknown as Uint8Array).digest("base64");

    it("stores a body that matches the declared checksum", async () => {
      await adapter.put("k", data, { checksumSha256: digest });
      expect((await adapter.stat("k"))?.checksumSha256).toBe(digest);
    });

    it("rejects a mismatched body rather than storing it", async () => {
      await expect(
        adapter.put("k", Buffer.from("different bytes"), { checksumSha256: digest }),
      ).rejects.toThrow(/BadDigest/);
      // Rejected, not stored — the distinction that makes a 200 mean something.
      expect(await adapter.has("k")).toBe(false);
    });

    it("reports null when no checksum was supplied, never a synthesized one", async () => {
      await adapter.put("k", data);
      // "Unknown", not "verified". A store that hashed the bytes itself at read
      // time would be answering a different question — it would say nothing
      // about whether these are the bytes the writer intended.
      expect((await adapter.stat("k"))?.checksumSha256).toBeNull();
    });
  });

  describe("stat", () => {
    it("returns null for an absent key", async () => {
      expect(await adapter.stat("nope")).toBeNull();
    });

    it("reports size and content type alongside availability", async () => {
      await adapter.put("k", Buffer.from("12345"), { contentType: "text/plain" });
      expect(await adapter.stat("k")).toMatchObject({
        sizeBytes: 5,
        contentType: "text/plain",
        availability: { state: "instant" },
      });
    });

    // The whole reason stat() exists: an archived object *exists* and cannot be
    // read. Code that decides whether a read will succeed — or whether it is
    // safe to drop the only other copy — must be able to tell those apart, and
    // has() cannot.
    it("distinguishes an archived object from an absent one", async () => {
      await adapter.put("k", Buffer.from("cold"));
      adapter.setAvailability("k", { state: "archived", tier: "DEEP_ARCHIVE", expectedLatencyHours: 12 }, "DEEP_ARCHIVE");

      expect(await adapter.has("k")).toBe(true);
      expect(await adapter.stat("k")).toMatchObject({
        storageClass: "DEEP_ARCHIVE",
        availability: { state: "archived", tier: "DEEP_ARCHIVE", expectedLatencyHours: 12 },
      });
    });

    it("reports a restore in flight", async () => {
      await adapter.put("k", Buffer.from("thawing"));
      adapter.setAvailability("k", { state: "restoring", readyAt: null });
      expect((await adapter.stat("k"))?.availability).toEqual({ state: "restoring", readyAt: null });
    });
  });
});
