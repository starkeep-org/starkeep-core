import { describe, expect, it } from "vitest";
import { digestFileName, digestText, rotateProviderToken } from "../src/digest.js";

describe("rotateProviderToken", () => {
  it("starts a typed token at rotation 1", () => {
    expect(rotateProviderToken("abc")).toEqual({ next: "abc#1", rotation: 1 });
  });

  it("increments the rotation on each later use", () => {
    expect(rotateProviderToken("abc#1")).toEqual({ next: "abc#2", rotation: 2 });
    expect(rotateProviderToken("abc#9")).toEqual({ next: "abc#10", rotation: 10 });
  });

  it("keeps a # inside the token", () => {
    expect(rotateProviderToken("a#b")).toEqual({ next: "a#b#1", rotation: 1 });
    expect(rotateProviderToken("a#b#3")).toEqual({ next: "a#b#4", rotation: 4 });
  });
});

describe("the digest file", () => {
  const at = new Date("2026-11-20T07:00:12.000Z");

  it("names one file per UTC day", () => {
    expect(digestFileName(at)).toBe("digest-2026-11-20.skexample");
  });

  it("states the counts and the rotation", () => {
    const text = digestText({
      at,
      runId: "run-1",
      counts: { files: 12, notes: 7, pinned: 2 },
      rotation: 3,
    });
    expect(text).toContain("Run run-1");
    expect(text).toContain("Example files: 12");
    expect(text).toContain("Notes: 7, 2 pinned");
    expect(text).toContain("Provider token: rotation 3");
  });

  it("says when no token is stored", () => {
    const text = digestText({
      at,
      runId: "run-1",
      counts: { files: 0, notes: 0, pinned: 0 },
      rotation: null,
    });
    expect(text).toContain("Provider token: none stored");
  });
});
