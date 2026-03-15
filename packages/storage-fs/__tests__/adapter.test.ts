import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsObjectStorageAdapter } from "../src/adapter.js";

describe("FsObjectStorageAdapter", () => {
  let adapter: FsObjectStorageAdapter;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "starkeep-fs-test-"));
    adapter = new FsObjectStorageAdapter({ basePath: tempDir });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("lifecycle", () => {
    it("should report healthy after init", async () => {
      expect(await adapter.healthCheck()).toBe(true);
    });

    it("should report unhealthy for non-existent path", async () => {
      const bad = new FsObjectStorageAdapter({ basePath: "/tmp/nonexistent-xyz-abc" });
      expect(await bad.healthCheck()).toBe(false);
    });
  });

  describe("put / get", () => {
    it("should store and retrieve data", async () => {
      const data = Buffer.from("hello world");
      await adapter.put("test-file", data, { contentType: "text/plain" });

      const result = await adapter.get("test-file");
      expect(result).not.toBeNull();
      expect(result!.data.toString()).toBe("hello world");
      expect(result!.contentType).toBe("text/plain");
      expect(result!.size).toBe(11);
    });

    it("should return null for non-existent key", async () => {
      expect(await adapter.get("missing")).toBeNull();
    });

    it("should store metadata", async () => {
      await adapter.put("key", Buffer.from("data"), {
        contentType: "application/octet-stream",
        metadata: { "x-custom": "value" },
      });

      const result = await adapter.get("key");
      expect(result!.metadata).toEqual({ "x-custom": "value" });
    });

    it("should handle binary data", async () => {
      const data = Buffer.from([0x00, 0xff, 0x42, 0xde, 0xad]);
      await adapter.put("binary-file", data);

      const result = await adapter.get("binary-file");
      expect(result!.size).toBe(5);
      expect(Buffer.from(result!.data)).toEqual(data);
    });

    it("should overwrite existing data on re-put", async () => {
      await adapter.put("key", Buffer.from("original"));
      await adapter.put("key", Buffer.from("updated"));

      const result = await adapter.get("key");
      expect(result!.data.toString()).toBe("updated");
    });

    it("should create content-addressable directory structure", async () => {
      // Key "abcdef" should be stored under "ab/abcdef"
      await adapter.put("abcdef", Buffer.from("data"));
      const result = await adapter.get("abcdef");
      expect(result).not.toBeNull();
    });
  });

  describe("delete", () => {
    it("should remove a file", async () => {
      await adapter.put("key", Buffer.from("data"));
      await adapter.delete("key");
      expect(await adapter.get("key")).toBeNull();
    });

    it("should not throw when deleting non-existent key", async () => {
      await expect(adapter.delete("missing")).resolves.not.toThrow();
    });

    it("should also remove metadata file", async () => {
      await adapter.put("key", Buffer.from("data"), { contentType: "text/plain" });
      await adapter.delete("key");

      // Re-put without metadata and verify no stale metadata
      await adapter.put("key", Buffer.from("new-data"));
      const result = await adapter.get("key");
      expect(result!.contentType).toBeUndefined();
    });
  });

  describe("list", () => {
    it("should list all keys", async () => {
      await adapter.put("aa-file1", Buffer.from(""));
      await adapter.put("bb-file2", Buffer.from(""));
      await adapter.put("cc-file3", Buffer.from(""));

      const result = await adapter.list("");
      expect(result.keys).toContain("aa-file1");
      expect(result.keys).toContain("bb-file2");
      expect(result.keys).toContain("cc-file3");
      expect(result.hasMore).toBe(false);
    });

    it("should filter by prefix", async () => {
      await adapter.put("photo-1", Buffer.from(""));
      await adapter.put("photo-2", Buffer.from(""));
      await adapter.put("doc-1", Buffer.from(""));

      const result = await adapter.list("photo");
      expect(result.keys).toEqual(["photo-1", "photo-2"]);
    });

    it("should return sorted keys", async () => {
      await adapter.put("cc-file", Buffer.from(""));
      await adapter.put("aa-file", Buffer.from(""));
      await adapter.put("bb-file", Buffer.from(""));

      const result = await adapter.list("");
      const sorted = [...result.keys].sort();
      expect(result.keys).toEqual(sorted);
    });

    it("should support pagination", async () => {
      await adapter.put("aa-1", Buffer.from(""));
      await adapter.put("aa-2", Buffer.from(""));
      await adapter.put("aa-3", Buffer.from(""));

      const page1 = await adapter.list("aa", { limit: 2 });
      expect(page1.keys).toHaveLength(2);
      expect(page1.hasMore).toBe(true);

      const page2 = await adapter.list("aa", { limit: 2, cursor: page1.nextCursor! });
      expect(page2.keys).toHaveLength(1);
      expect(page2.hasMore).toBe(false);
    });
  });
});
