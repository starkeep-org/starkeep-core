import { describe, it, expect, beforeEach } from "vitest";
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
      await adapter.put("photos/a.jpg", Buffer.from(""));
      await adapter.put("photos/b.jpg", Buffer.from(""));
      await adapter.put("docs/c.txt", Buffer.from(""));

      const result = await adapter.list("photos/");
      expect(result.keys).toEqual(["photos/a.jpg", "photos/b.jpg"]);
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
});
