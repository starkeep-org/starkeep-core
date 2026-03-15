import { describe, it, expect } from "vitest";
import { computeInputHash } from "../src/input-hasher.js";

describe("computeInputHash", () => {
  it("should produce consistent hashes for same inputs", () => {
    const hash1 = computeInputHash("record-1", ["dep-1"], { width: 100 });
    const hash2 = computeInputHash("record-1", ["dep-1"], { width: 100 });

    expect(hash1).toBe(hash2);
  });

  it("should produce different hashes for different inputs", () => {
    const hash1 = computeInputHash("record-1", ["dep-1"], { width: 100 });
    const hash2 = computeInputHash("record-2", ["dep-1"], { width: 100 });

    expect(hash1).not.toBe(hash2);
  });

  it("should be order-independent for dependency IDs", () => {
    const hash1 = computeInputHash("record-1", ["dep-1", "dep-2"], {});
    const hash2 = computeInputHash("record-1", ["dep-2", "dep-1"], {});

    expect(hash1).toBe(hash2);
  });

  it("should be order-independent for parameter keys", () => {
    const hash1 = computeInputHash("record-1", [], { a: 1, b: 2 });
    const hash2 = computeInputHash("record-1", [], { b: 2, a: 1 });

    expect(hash1).toBe(hash2);
  });

  it("should produce a hex string", () => {
    const hash = computeInputHash("record-1", [], {});

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should differentiate between different parameter values", () => {
    const hash1 = computeInputHash("record-1", [], { size: 100 });
    const hash2 = computeInputHash("record-1", [], { size: 200 });

    expect(hash1).not.toBe(hash2);
  });
});
