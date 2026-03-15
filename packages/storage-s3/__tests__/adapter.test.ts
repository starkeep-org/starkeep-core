import { describe, it, expect } from "vitest";
import { S3ObjectStorageAdapter } from "../src/adapter.js";
import type { S3ObjectStorageAdapterOptions } from "../src/types.js";

describe("S3ObjectStorageAdapter", () => {
  const validOptions: S3ObjectStorageAdapterOptions = {
    bucketName: "test-bucket",
    region: "us-east-1",
    keyPrefix: "data/",
    credentials: {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    },
  };

  describe("construction", () => {
    it("should construct with all options", () => {
      const adapter = new S3ObjectStorageAdapter(validOptions);
      expect(adapter).toBeInstanceOf(S3ObjectStorageAdapter);
    });

    it("should construct with minimal options", () => {
      const adapter = new S3ObjectStorageAdapter({
        bucketName: "my-bucket",
        region: "eu-west-1",
      });
      expect(adapter).toBeInstanceOf(S3ObjectStorageAdapter);
    });
  });

  describe("interface conformance", () => {
    it("should implement all ObjectStorageAdapter methods", () => {
      const adapter = new S3ObjectStorageAdapter(validOptions);

      expect(typeof adapter.init).toBe("function");
      expect(typeof adapter.close).toBe("function");
      expect(typeof adapter.healthCheck).toBe("function");
      expect(typeof adapter.put).toBe("function");
      expect(typeof adapter.get).toBe("function");
      expect(typeof adapter.delete).toBe("function");
      expect(typeof adapter.list).toBe("function");
      expect(typeof adapter.getSignedUrl).toBe("function");
    });
  });

  describe("init", () => {
    it("should resolve without error (no-op)", async () => {
      const adapter = new S3ObjectStorageAdapter(validOptions);
      await expect(adapter.init()).resolves.toBeUndefined();
    });
  });

  describe("close", () => {
    it("should resolve without error when no client exists", async () => {
      const adapter = new S3ObjectStorageAdapter(validOptions);
      await expect(adapter.close()).resolves.toBeUndefined();
    });
  });
});
