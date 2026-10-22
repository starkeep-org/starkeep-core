/**
 * Whether a shared file is in S3, decided from Drive's bytes watermark and,
 * above it, a HEAD.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HLCTimestamp } from "@starkeep/protocol-primitives";
import {
  createBytePresence,
  createPresentKeyCache,
  type PresenceRow,
} from "../src/byte-presence.js";

const at = (wallTime: number, nodeId = "phone"): HLCTimestamp => ({ wallTime, counter: 0, nodeId });
const row = (key: string, wallTime: number, nodeId = "phone"): PresenceRow => ({
  key,
  updatedAt: at(wallTime, nodeId),
});

let inStorage: Set<string>;
let has: ReturnType<typeof vi.fn<(key: string) => Promise<boolean>>>;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  inStorage = new Set();
  has = vi.fn(async (key: string) => inStorage.has(key));
});

function presence(
  watermarks: Record<string, HLCTimestamp> | Error = { phone: at(100) },
  extra: { maxChecks?: number; cache?: ReturnType<typeof createPresentKeyCache> } = {},
) {
  return createBytePresence({
    loadWatermarks: async () => {
      if (watermarks instanceof Error) throw watermarks;
      return watermarks;
    },
    has,
    cache: extra.cache ?? createPresentKeyCache(),
    ...(extra.maxChecks !== undefined ? { maxChecks: extra.maxChecks } : {}),
  });
}

describe("byte presence", () => {
  it("trusts the watermark for a row at or below it, and checks nothing", async () => {
    const missing = await presence().missing([row("a", 100), row("b", 50)]);
    expect([...missing]).toEqual([]);
    expect(has).not.toHaveBeenCalled();
  });

  it("checks a row above the watermark, and reports it missing when S3 lacks it", async () => {
    const missing = await presence().missing([row("a", 101)]);
    expect([...missing]).toEqual(["a"]);
    expect(has).toHaveBeenCalledWith("a");
  });

  it("checks a row above the watermark, and reports nothing when S3 holds it", async () => {
    inStorage.add("a");
    const missing = await presence().missing([row("a", 101)]);
    expect([...missing]).toEqual([]);
  });

  it("checks every row by an author the watermark has not heard of", async () => {
    const missing = await presence().missing([row("a", 1, "other-phone")]);
    expect([...missing]).toEqual(["a"]);
  });

  it("counts a key covered when any row naming it is covered", async () => {
    const missing = await presence().missing([row("a", 500), row("a", 10)]);
    expect([...missing]).toEqual([]);
    expect(has).not.toHaveBeenCalled();
  });

  it("remembers a key it found, across requests on one cache", async () => {
    const cache = createPresentKeyCache();
    inStorage.add("a");
    await presence(undefined, { cache }).missing([row("a", 101)]);
    await presence(undefined, { cache }).missing([row("a", 101)]);
    expect(has).toHaveBeenCalledTimes(1);
  });

  it("never remembers a key it did not find", async () => {
    const cache = createPresentKeyCache();
    await presence(undefined, { cache }).missing([row("a", 101)]);
    inStorage.add("a");
    const missing = await presence(undefined, { cache }).missing([row("a", 101)]);
    expect([...missing]).toEqual([]);
    expect(has).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used key past its capacity", () => {
    const cache = createPresentKeyCache(2);
    cache.add("a");
    cache.add("b");
    expect(cache.has("a")).toBe(true);
    cache.add("c");
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  it("signs keys past the cap unchecked, across calls in one request", async () => {
    const p = presence(undefined, { maxChecks: 2 });
    const first = await p.missing([row("a", 101), row("b", 101), row("c", 101)]);
    expect([...first].sort()).toEqual(["a", "b"]);
    const second = await p.missing([row("d", 101)]);
    expect([...second]).toEqual([]);
    expect(has).toHaveBeenCalledTimes(2);
  });

  it("checks every row when the watermark will not load", async () => {
    inStorage.add("b");
    const missing = await presence(new Error("permission denied for schema")).missing([
      row("a", 1),
      row("b", 1),
    ]);
    expect([...missing]).toEqual(["a"]);
    expect(has).toHaveBeenCalledTimes(2);
  });

  it("reads the watermark once per request, and not at all when nothing is asked", async () => {
    const loadWatermarks = vi.fn(async () => ({ phone: at(100) }));
    const p = createBytePresence({ loadWatermarks, has, cache: createPresentKeyCache() });
    await p.missing([]);
    expect(loadWatermarks).not.toHaveBeenCalled();
    await p.missing([row("a", 1)]);
    await p.missing([row("b", 1)]);
    expect(loadWatermarks).toHaveBeenCalledTimes(1);
  });

  it("treats a failed check as present, and does not remember it", async () => {
    const cache = createPresentKeyCache();
    has.mockRejectedValueOnce(new Error("SlowDown"));
    const missing = await presence(undefined, { cache }).missing([row("a", 101)]);
    expect([...missing]).toEqual([]);
    expect(cache.has("a")).toBe(false);
  });
});
