import { describe, it, expect } from "vitest";
import { generateId, generateIdAt, isStarkeepId, createStarkeepId } from "../src/identifiers/index.js";

describe("identifiers", () => {
  describe("generateId", () => {
    it("should generate a 26-character ULID string", () => {
      const id = generateId();
      expect(id).toHaveLength(26);
      expect(typeof id).toBe("string");
    });

    it("should generate unique IDs", () => {
      const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
      expect(ids.size).toBe(1000);
    });

    it("should generate monotonically sortable IDs", () => {
      const ids = Array.from({ length: 100 }, () => generateId());
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    });
  });

  describe("generateIdAt", () => {
    it("should generate an ID at a specific timestamp", () => {
      const timestamp = 1700000000000;
      const id = generateIdAt(timestamp);
      expect(id).toHaveLength(26);
    });

    it("should produce IDs that sort by timestamp", () => {
      const earlier = generateIdAt(1700000000000);
      const later = generateIdAt(1700000001000);
      expect(earlier < later).toBe(true);
    });
  });

  describe("isStarkeepId", () => {
    it("should return true for valid ULID strings", () => {
      const id = generateId();
      expect(isStarkeepId(id)).toBe(true);
    });

    it("should return false for non-string values", () => {
      expect(isStarkeepId(123)).toBe(false);
      expect(isStarkeepId(null)).toBe(false);
      expect(isStarkeepId(undefined)).toBe(false);
    });

    it("should return false for wrong-length strings", () => {
      expect(isStarkeepId("short")).toBe(false);
      expect(isStarkeepId("this-is-way-too-long-to-be-a-ulid")).toBe(false);
    });
  });

  describe("createStarkeepId", () => {
    it("should create a branded StarkeepId from a string", () => {
      const id = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(typeof id).toBe("string");
      expect(id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    });
  });
});
