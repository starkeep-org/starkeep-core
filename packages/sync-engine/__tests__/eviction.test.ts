/**
 * Eviction, byte accounting, and the durability predicate.
 *
 * **These are the tests that guard the one part of the media plan that
 * destroys data if it is wrong.** Every case below that asserts something is
 * *kept* would delete a wanted object if the guard it covers were removed. A
 * suite that only checked the happy path here would pass just as well against
 * a version that evicts everything.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createSqliteResidentSetIndex, type ResidentEntry, type ResidentSetIndex } from "../src/resident-set.js";
import { assessDurability, type ReplicaProbe } from "../src/durability.js";
import {
  evictLine,
  previewBudgetReduction,
  shedLoad,
  SHED_ORDER,
} from "../src/eviction.js";
import {
  budgetLineFor,
  parseSizeClass,
  type NodeRetentionPolicy,
} from "../src/residency-policy.js";

const bytesFor = (n: number) => Buffer.alloc(n, n % 256);
const hashOf = (b: Buffer) => createHash("sha256").update(b as unknown as Uint8Array).digest("hex");
const b64Of = (b: Buffer) => createHash("sha256").update(b as unknown as Uint8Array).digest("base64");
const keyFor = (hash: string) => `shared/image/${hash.slice(0, 2)}/${hash}`;

function entry(over: Partial<ResidentEntry> & { objectStorageKey: string; sizeBytes: number }): ResidentEntry {
  return {
    recordId: over.recordId ?? over.objectStorageKey,
    sizeClass: CLASS_A,
    // What a blob *is* and what it is *charged to* are two columns. They match
    // here for a declared rung; the pooled-fallback suite below is where they
    // deliberately do not.
    budgetLineKey: over.sizeClass ?? CLASS_A,
    namespace: "appA",
    pinned: false,
    protectedLocally: false,
    requiresDurabilityProof: true,
    recencyAtMs: null,
    lastOpenedAtMs: null,
    addedAtMs: 0,
    // These entries stand for bytes already on disk, which is what every case
    // in this file is about — a pass deciding whether to delete something it
    // holds.
    resident: true,
    reserved: false,
    ...over,
  };
}

/**
 * A policy giving `classA` exactly `budgetBytes`.
 *
 * Shares divide one namespace budget, so a suite that wants a class capped at a
 * number has to say what else is claiming a share. `classA` takes it all unless
 * a case widens the fallback — which is what the pooled-line suite does.
 */
const policy = (
  budgetBytes: number,
  fallbackShare = 0,
): NodeRetentionPolicy => ({
  platform: { rows: {}, fallback: { prefetch: true, share: 1 }, budgetBytes: budgetBytes || 1 },
  apps: {
    appA: {
      rows: { classA: { prefetch: true, share: 1 } },
      fallback: { prefetch: true, share: fallbackShare },
      budgetBytes: budgetBytes * (1 + fallbackShare) || 1,
    },
  },
  appFallback: {
    rows: {},
    fallback: { prefetch: true, share: 1 },
    budgetBytes: budgetBytes || 1,
  },
});

/** The budget line a stored class name resolves to, under a given policy. */
const lineOf = (p: NodeRetentionPolicy, sizeClass: string) =>
  budgetLineFor(p, parseSizeClass(sizeClass));

/** Class names are stored fully qualified; the row key is only the rung. */
const CLASS_A = "appA:classA";
const CLASS_B = "appA:classB";
/** Where every rung `appA` has not declared is pooled. */
const FALLBACK_LINE = "appA:*";

describe("resident-set index", () => {
  let db: DatabaseSync;
  let index: ResidentSetIndex;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    index = createSqliteResidentSetIndex({ db });
  });

  it("sums bytes per class without probing storage", () => {
    index.add(entry({ objectStorageKey: "a", sizeBytes: 100 }));
    index.add(entry({ objectStorageKey: "b", sizeBytes: 250 }));
    index.add(entry({ objectStorageKey: "c", sizeBytes: 40, sizeClass: CLASS_B }));

    expect(index.usageOf(CLASS_A)).toBe(350);
    expect(index.usageByClass()).toEqual({ [CLASS_A]: 350, [CLASS_B]: 40 });
    expect(index.countByClass()).toEqual({ [CLASS_A]: 2, [CLASS_B]: 1 });
  });

  it("is idempotent on the object key, so a re-sync does not double-count", () => {
    index.add(entry({ objectStorageKey: "a", sizeBytes: 100 }));
    index.add(entry({ objectStorageKey: "a", sizeBytes: 100 }));
    expect(index.usageOf(CLASS_A)).toBe(100);
  });

  // A pin and a last-opened time are node-local *user* state. A re-arrival of
  // the same bytes — a re-sync, a re-derivation — is not a reason to forget
  // that someone pinned this or looked at it yesterday.
  it("preserves pins and open times across a re-add", () => {
    index.add(entry({ objectStorageKey: "a", sizeBytes: 100 }));
    index.setPinned("a", true);
    index.markOpened("a", 12345);

    index.add(entry({ objectStorageKey: "a", sizeBytes: 100 }));

    expect(index.get("a")).toMatchObject({ pinned: true, lastOpenedAtMs: 12345 });
  });

  it("finds every held blob of one record, so a pin covers all its renditions", () => {
    index.add(entry({ objectStorageKey: "orig", sizeBytes: 100, recordId: "r1" }));
    index.add(entry({ objectStorageKey: "thumb", sizeBytes: 10, recordId: "r1", sizeClass: CLASS_B }));
    index.add(entry({ objectStorageKey: "other", sizeBytes: 10, recordId: "r2" }));

    expect(index.entriesOfRecord("r1").map((e) => e.objectStorageKey).sort()).toEqual([
      "orig",
      "thumb",
    ]);
  });

  describe("eviction candidate ordering", () => {
    // Least-recently-useful: never-opened before anything anyone has actually
    // looked at, then oldest-opened.
    it("puts never-opened material first, then oldest-opened", () => {
      index.add(entry({ objectStorageKey: "opened-recently", sizeBytes: 10, lastOpenedAtMs: 900 }));
      index.add(entry({ objectStorageKey: "never-opened", sizeBytes: 10 }));
      index.add(entry({ objectStorageKey: "opened-long-ago", sizeBytes: 10, lastOpenedAtMs: 100 }));

      const order = index
        .evictionCandidates({ budgetLineKey: CLASS_A, targetBytes: 999 })
        .map((e) => e.objectStorageKey);
      expect(order).toEqual(["never-opened", "opened-long-ago", "opened-recently"]);
    });

    // Excluded in the query rather than filtered by the caller, so a caller
    // cannot forget to.
    it("never offers pinned or locally-protected entries", () => {
      index.add(entry({ objectStorageKey: "pinned", sizeBytes: 10, pinned: true }));
      index.add(entry({ objectStorageKey: "protected", sizeBytes: 10, protectedLocally: true }));
      index.add(entry({ objectStorageKey: "ordinary", sizeBytes: 10 }));

      const keys = index
        .evictionCandidates({ budgetLineKey: CLASS_A, targetBytes: 999 })
        .map((e) => e.objectStorageKey);
      expect(keys).toEqual(["ordinary"]);
    });
  });
});

describe("durability predicate", () => {
  const data = bytesFor(64);
  const hash = hashOf(data);
  const key = keyFor(hash);
  const query = { objectStorageKey: key, contentHash: hash, sizeBytes: data.length };

  async function peer(
    setup: (s: MockObjectStorageAdapter) => Promise<void> | void,
  ): Promise<ReplicaProbe> {
    const storage = new MockObjectStorageAdapter();
    await storage.init();
    await setup(storage);
    return { nodeId: "peer", storage };
  }

  it("confirms a replica whose stored checksum matches the record", async () => {
    const p = await peer((s) => s.put(key, data, { checksumSha256: b64Of(data) }));
    const verdict = await assessDurability(query, [p], { minimumReplicas: 1 });
    expect(verdict.durable).toBe(true);
    expect(verdict.confirmedReplicas).toBe(1);
  });

  // The plan's stance: "a reduction that would evict originals must refuse
  // rather than proceed". A store that verified nothing at write time cannot
  // be treated as though it had.
  it("does not count a present-but-unverified replica by default", async () => {
    const p = await peer((s) => s.put(key, data));
    const verdict = await assessDurability(query, [p], { minimumReplicas: 1 });
    expect(verdict.durable).toBe(false);
    expect(verdict.unverifiedReplicas).toBe(1);
  });

  it("counts unverified replicas only when told to explicitly", async () => {
    const p = await peer((s) => s.put(key, data));
    const verdict = await assessDurability(query, [p], {
      minimumReplicas: 1,
      countUnverified: true,
    });
    expect(verdict.durable).toBe(true);
  });

  it("refuses, and reports corruption, when a replica's checksum disagrees", async () => {
    const wrong = bytesFor(64).fill(7);
    const p = await peer((s) => s.put(key, wrong, { checksumSha256: b64Of(wrong) }));
    const verdict = await assessDurability(query, [p], { minimumReplicas: 1 });
    expect(verdict.durable).toBe(false);
    expect(verdict.corruptionSuspected).toBe(true);
  });

  it("refuses, and reports corruption, when a replica is the wrong size", async () => {
    const p = await peer((s) => s.put(key, bytesFor(8)));
    const verdict = await assessDurability(query, [p], { minimumReplicas: 1 });
    expect(verdict.durable).toBe(false);
    expect(verdict.corruptionSuspected).toBe(true);
  });

  // "I couldn't tell" must read as neither "it isn't there" nor "it's fine".
  it("treats a failing probe as no evidence at all", async () => {
    const broken: ReplicaProbe = {
      nodeId: "broken",
      storage: {
        ...new MockObjectStorageAdapter(),
        stat: async () => {
          throw new Error("network down");
        },
      } as unknown as MockObjectStorageAdapter,
    };
    const verdict = await assessDurability(query, [broken], { minimumReplicas: 1 });
    expect(verdict.durable).toBe(false);
    expect(verdict.corruptionSuspected).toBe(false);
    expect(verdict.replicas[0]!.state).toBe("probe-failed");
  });

  // Durable and readable are different questions, and answering the first with
  // the second produces a twelve-hour surprise.
  it("counts an archived replica as durable but not as instantly readable", async () => {
    const storage = new MockObjectStorageAdapter();
    await storage.init();
    await storage.put(key, data, { checksumSha256: b64Of(data) });
    storage.setAvailability(key, { state: "archived", tier: "DEEP_ARCHIVE", expectedLatencyHours: 12 });

    const verdict = await assessDurability(query, [{ nodeId: "cold", storage }], {
      minimumReplicas: 1,
    });
    expect(verdict.durable).toBe(true);
    expect(verdict.confirmedReplicas).toBe(1);
    expect(verdict.instantReplicas).toBe(0);
  });

  it("requires the configured minimum, not merely one", async () => {
    const p = await peer((s) => s.put(key, data, { checksumSha256: b64Of(data) }));
    expect((await assessDurability(query, [p], { minimumReplicas: 2 })).durable).toBe(false);
  });
});

describe("eviction pass", () => {
  let db: DatabaseSync;
  let index: ResidentSetIndex;
  let localStorage: MockObjectStorageAdapter;

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    index = createSqliteResidentSetIndex({ db });
    localStorage = new MockObjectStorageAdapter();
    await localStorage.init();
  });

  /** Put `count` blobs of `size` bytes locally, all confirmed on `peerStorage`. */
  async function seed(count: number, size: number, opts: {
    confirmedElsewhere?: boolean;
    requiresDurabilityProof?: boolean;
  } = {}): Promise<{ probes: ReplicaProbe[]; keys: string[]; hashes: Map<string, string> }> {
    const peerStorage = new MockObjectStorageAdapter();
    await peerStorage.init();
    const keys: string[] = [];
    const hashes = new Map<string, string>();

    for (let i = 0; i < count; i++) {
      const data = Buffer.alloc(size, i + 1);
      const hash = hashOf(data);
      const key = keyFor(hash);
      keys.push(key);
      hashes.set(key, hash);
      await localStorage.put(key, data);
      if (opts.confirmedElsewhere ?? true) {
        await peerStorage.put(key, data, { checksumSha256: b64Of(data) });
      }
      index.add(
        entry({
          objectStorageKey: key,
          sizeBytes: size,
          lastOpenedAtMs: i,
          requiresDurabilityProof: opts.requiresDurabilityProof ?? true,
        }),
      );
    }
    return { probes: [{ nodeId: "peer", storage: peerStorage }], keys, hashes };
  }

  function request(seeded: { probes: ReplicaProbe[]; hashes: Map<string, string> }, budget: number) {
    const p = policy(budget);
    return {
      budgetLine: lineOf(p, CLASS_A),
      index,
      policy: p,
      localStorage,
      probes: seeded.probes,
      durability: { minimumReplicas: 1 },
      contentHashOf: (e: ResidentEntry) => seeded.hashes.get(e.objectStorageKey) ?? null,
    };
  }

  it("does nothing while a line is inside its budget", async () => {
    const seeded = await seed(5, 100);
    // 500 held against a 1000 budget.
    const outcome = await evictLine(request(seeded, 1000));
    expect(outcome.triggered).toBe(false);
    expect(outcome.evicted).toHaveLength(0);
  });

  /**
   * **The budget is the only level**, and a line sitting exactly on it is a
   * line doing what it was told.
   *
   * This used to trigger at 95% and free to 80%, as hysteresis against evicting
   * on every arrival. Both fractions are gone, because something now refills a
   * line: the acquisition pass fills back up to the budget, so any gap between
   * where this pass stops and where that one stops is a pump — free to 80%,
   * refetch to 100%, free again, for ever. Equal numbers are the whole of what
   * makes the pair stable.
   */
  it("does nothing when a line is exactly at its budget", async () => {
    const seeded = await seed(10, 100);
    const outcome = await evictLine(request(seeded, 1000));
    expect(outcome.triggered).toBe(false);
    expect(outcome.evicted).toHaveLength(0);
  });

  it("frees down to exactly the budget once a line is over it", async () => {
    const seeded = await seed(10, 100);
    // 1000 held against a 700 budget, so 300 has to go.
    const outcome = await evictLine(request(seeded, 700));
    expect(outcome.triggered).toBe(true);
    expect(outcome.bytesAfter).toBeLessThanOrEqual(700);
    // …and not far past it: this is a trim, not a purge.
    expect(outcome.bytesAfter).toBeGreaterThan(500);
    expect(outcome.shortfall).toBe(false);
  });

  // The row survives the bytes, deliberately. Deleting it would leave nothing
  // able to distinguish "this node declined these bytes and the peer will offer
  // them again if the policy changes" from "this node held them, dropped them,
  // and no sync round will ever send them again" — because eviction happens long
  // after the watermark moved past the record. Without the departed row,
  // `residencyOf` reports `staged` (still owed) for bytes nobody is going to
  // send.
  it("deletes the bytes and marks the index row departed", async () => {
    const seeded = await seed(10, 100);
    const outcome = await evictLine(request(seeded, 700));
    expect(outcome.evicted.length).toBeGreaterThan(0);
    for (const e of outcome.evicted) {
      expect(await localStorage.has(e.objectStorageKey)).toBe(false);
      expect(index.get(e.objectStorageKey)?.resident).toBe(false);
      expect(index.wasEvicted(e.objectStorageKey)).toBe(true);
    }
  });

  // The half that makes the departed row safe to keep: it must not go on being
  // counted. A class whose bytes are gone but whose usage still reports them
  // full is a class the next pass will try to empty again, forever.
  it("stops counting departed bytes toward the budget", async () => {
    const seeded = await seed(10, 100);
    const before = index.usageOf(CLASS_A);
    const outcome = await evictLine(request(seeded, 700));
    const freed = outcome.evicted.reduce((n, e) => n + e.sizeBytes, 0);
    expect(freed).toBeGreaterThan(0);
    expect(index.usageOf(CLASS_A)).toBe(before - freed);
  });

  // ---- The cases that would destroy data if the guard were removed ----

  it("refuses to evict anything not confirmed elsewhere", async () => {
    const seeded = await seed(10, 100, { confirmedElsewhere: false });
    const outcome = await evictLine(request(seeded, 700));

    expect(outcome.evicted).toHaveLength(0);
    expect(outcome.kept.every((k) => k.reason === "not-confirmed-elsewhere")).toBe(true);
    // And it says so, rather than reporting success it did not achieve.
    expect(outcome.shortfall).toBe(true);
    // Every byte is still on disk.
    for (const key of seeded.keys) expect(await localStorage.has(key)).toBe(true);
  });

  it("refuses when there is no content hash to verify a replica against", async () => {
    const seeded = await seed(10, 100);
    const outcome = await evictLine({ ...request(seeded, 700), contentHashOf: () => null });
    expect(outcome.evicted).toHaveLength(0);
    expect(outcome.kept[0]!.reason).toBe("not-confirmed-elsewhere");
  });

  it("refuses to drop the last instantly-readable copy", async () => {
    const seeded = await seed(10, 100);
    const peerStorage = seeded.probes[0]!.storage as MockObjectStorageAdapter;
    for (const key of seeded.keys) {
      peerStorage.setAvailability(key, {
        state: "archived",
        tier: "DEEP_ARCHIVE",
        expectedLatencyHours: 12,
      });
    }

    const outcome = await evictLine(request(seeded, 700));
    expect(outcome.evicted).toHaveLength(0);
    expect(outcome.kept.every((k) => k.reason === "last-instantly-readable-copy")).toBe(true);
  });

  it("allows dropping the last readable copy when the caller opts out", async () => {
    const seeded = await seed(10, 100);
    const peerStorage = seeded.probes[0]!.storage as MockObjectStorageAdapter;
    for (const key of seeded.keys) {
      peerStorage.setAvailability(key, {
        state: "archived",
        tier: "DEEP_ARCHIVE",
        expectedLatencyHours: 12,
      });
    }
    const outcome = await evictLine({ ...request(seeded, 700), keepLastInstantCopy: false });
    expect(outcome.evicted.length).toBeGreaterThan(0);
  });

  it("surfaces suspected corruption rather than only suppressing the eviction", async () => {
    const seeded = await seed(10, 100);
    const peerStorage = seeded.probes[0]!.storage as MockObjectStorageAdapter;
    // Replace one peer copy with different bytes at the same key.
    const badKey = seeded.keys[0]!;
    const wrong = Buffer.alloc(100, 99);
    await peerStorage.delete(badKey);
    await peerStorage.put(badKey, wrong, { checksumSha256: b64Of(wrong) });

    const outcome = await evictLine(request(seeded, 700));
    expect(outcome.corruptionSuspected).toContain(badKey);
  });

  // Renditions are cheaply re-derivable, so they don't need a durable replica
  // elsewhere — that distinction is what makes a phone's cache workable at all.
  // But "re-derivable" is a claim about the *host*, not about the bytes, so the
  // host has to make it.
  it("evicts re-derivable blobs without proof, on a host that can re-derive", async () => {
    const seeded = await seed(10, 100, {
      confirmedElsewhere: false,
      requiresDurabilityProof: false,
    });
    const outcome = await evictLine({ ...request(seeded, 700), canRederive: true });
    expect(outcome.evicted.length).toBeGreaterThan(0);
  });

  // The default, and the case this branch is actually in: derivation (item 7) is
  // not implemented, so a deleted rendition is gone until something writes it
  // for the first time. Skipping the durability check for it would be deleting
  // on the strength of a capability nobody has.
  it("still demands proof for a rendition when nothing can re-derive it", async () => {
    const seeded = await seed(10, 100, {
      confirmedElsewhere: false,
      requiresDurabilityProof: false,
    });
    const outcome = await evictLine(request(seeded, 700));
    expect(outcome.evicted).toHaveLength(0);
    expect(outcome.kept.every((k) => k.reason === "not-confirmed-elsewhere")).toBe(true);
    expect(outcome.shortfall).toBe(true);
  });
});

describe("the pooled fallback line", () => {
  let db: DatabaseSync;
  let index: ResidentSetIndex;
  let localStorage: MockObjectStorageAdapter;

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    index = createSqliteResidentSetIndex({ db });
    localStorage = new MockObjectStorageAdapter();
    await localStorage.init();
  });

  /**
   * What this suite replaced, and why the replacement is smaller.
   *
   * There used to be a second eviction pass over whole namespaces, because a
   * row carried an absolute byte count and an app carried a separate total, and
   * the two failed independently — an app could sit inside every one of its
   * rows and still breach its total, and a per-class pass would find nothing to
   * do. Rows are shares of one namespace budget now, so the lines sum to it
   * exactly and that case cannot arise.
   *
   * What genuinely needed the second pass was rung *invention*: a per-rung
   * fallback handed out one budget per invented name, and only a namespace-wide
   * cap bounded it. That is now one pooled line, which the ordinary pass
   * enforces like any other — so these cases are about several classes sharing
   * one budget rather than about a second kind of budget.
   */
  async function seedInventedRungs(count: number, size: number) {
    const peerStorage = new MockObjectStorageAdapter();
    await peerStorage.init();
    const hashes = new Map<string, string>();
    for (let i = 0; i < count; i++) {
      const data = Buffer.alloc(size, i + 1);
      const hash = hashOf(data);
      const key = keyFor(hash);
      hashes.set(key, hash);
      await localStorage.put(key, data);
      await peerStorage.put(key, data, { checksumSha256: b64Of(data) });
      index.add(
        entry({
          objectStorageKey: key,
          sizeBytes: size,
          lastOpenedAtMs: i,
          // Two rung names the policy has never heard of. Different classes for
          // reporting, one budget line between them.
          sizeClass: i % 2 === 0 ? "appA:invented-one" : "appA:invented-two",
          budgetLineKey: FALLBACK_LINE,
          // Renditions: everything in an app namespace has a parent by
          // construction.
          requiresDurabilityProof: false,
        }),
      );
    }
    return {
      index,
      localStorage,
      probes: [{ nodeId: "peer", storage: peerStorage }] as ReplicaProbe[],
      durability: { minimumReplicas: 1 },
      contentHashOf: (e: ResidentEntry) => hashes.get(e.objectStorageKey) ?? null,
    };
  }

  /** `classA` at 1000 bytes, and the fallback line at the same again. */
  const pooling = policy(1000, 1);
  const fallbackLine = lineOf(pooling, "appA:anything-undeclared");

  it("does nothing while the pooled line is under budget", async () => {
    const seeded = await seedInventedRungs(5, 100);
    const outcome = await evictLine({ ...seeded, budgetLine: fallbackLine, policy: pooling });
    expect(outcome.triggered).toBe(false);
  });

  // The case that used to need the second pass. Ten invented rungs would once
  // have had ten budgets; here they share one, so the ordinary pass sees the
  // breach and acts on it.
  it("evicts across every class on the line when the line is full", async () => {
    const seeded = await seedInventedRungs(20, 100);
    const outcome = await evictLine({ ...seeded, budgetLine: fallbackLine, policy: pooling });
    expect(outcome.triggered).toBe(true);
    expect(outcome.bytesAfter).toBeLessThanOrEqual(1000);
    // Both class names gave something up: the ordering is least-recently-useful
    // across the line, not "pick on the biggest class".
    expect(new Set(outcome.evicted.map((e) => e.sizeClass)).size).toBe(2);
  });

  it("reports the line it was working over", async () => {
    const seeded = await seedInventedRungs(20, 100);
    const outcome = await evictLine({ ...seeded, budgetLine: fallbackLine, policy: pooling });
    expect(outcome.budgetLine.key).toBe(FALLBACK_LINE);
  });

  // A declared rung has a line of its own, so a full fallback line must not
  // reach into it. This is the guarantee the old namespace pass could not make.
  it("does not touch a declared rung's line", async () => {
    const seeded = await seedInventedRungs(20, 100);
    index.add(entry({ objectStorageKey: "declared", sizeBytes: 900 }));
    await evictLine({ ...seeded, budgetLine: fallbackLine, policy: pooling });
    expect(index.usageOf(CLASS_A)).toBe(900);
  });

  // `validateRetentionPolicy` refuses a policy whose budget is missing, so this
  // is the second line rather than the first — but it is the line that matters,
  // because a NaN budget does not read as "small". Every comparison against it
  // is false: the over-budget check does not hold, so the pass runs, and the
  // target check does not hold either, so it runs until there is nothing left.
  it("refuses to run at all against a budget that is not a number", async () => {
    const seeded = await seedInventedRungs(20, 100);
    const broken: NodeRetentionPolicy = {
      ...pooling,
      apps: {
        appA: { ...pooling.apps.appA!, budgetBytes: undefined as unknown as number },
      },
    };
    const outcome = await evictLine({ ...seeded, budgetLine: fallbackLine, policy: broken });
    expect(outcome.triggered).toBe(false);
    expect(outcome.evicted).toHaveLength(0);
    expect(index.usageOf(FALLBACK_LINE)).toBe(2000);
  });

  // Zero is not the same case, and must keep working: it is what `share: 0`
  // means, and evicting the whole line is the point.
  it("still evicts everything against a real zero budget", async () => {
    const seeded = await seedInventedRungs(20, 100);
    const off: NodeRetentionPolicy = {
      ...pooling,
      apps: {
        appA: { ...pooling.apps.appA!, fallback: { prefetch: true, share: 0 } },
      },
    };
    const outcome = await evictLine({ ...seeded, budgetLine: fallbackLine, policy: off });
    expect(outcome.triggered).toBe(true);
    expect(index.usageOf(FALLBACK_LINE)).toBe(0);
  });

  // A pin wins over a pooled budget exactly as it wins over a declared one: the
  // pass treats the pinned set as fixed and reports the overage rather than
  // swallowing it.
  it("still refuses to drop pinned bytes", async () => {
    const seeded = await seedInventedRungs(20, 100);
    for (const e of index.evictionCandidates({
      budgetLineKey: FALLBACK_LINE,
      targetBytes: Number.MAX_SAFE_INTEGER,
    })) {
      index.setPinned(e.objectStorageKey, true);
    }
    const outcome = await evictLine({ ...seeded, budgetLine: fallbackLine, policy: pooling });
    expect(outcome.evicted).toHaveLength(0);
    expect(outcome.shortfall).toBe(true);
  });
});

describe("backpressure", () => {
  // Capture never blocks, so everything else gives way first — in a defined
  // order rather than whichever check happens to run.
  it("advances one step at a time and stops at the last", () => {
    const short = { shortfall: true } as never;
    expect(shedLoad(short, null)).toBe(SHED_ORDER[0]);
    expect(shedLoad(short, SHED_ORDER[0])).toBe(SHED_ORDER[1]);
    expect(shedLoad(short, SHED_ORDER[1])).toBe(SHED_ORDER[2]);
    expect(shedLoad(short, SHED_ORDER[2])).toBe(SHED_ORDER[2]);
  });

  it("releases backpressure entirely once the class fits again", () => {
    expect(shedLoad({ shortfall: false } as never, SHED_ORDER[2])).toBeNull();
  });

  it("prompts the operator only after the automatic measures are exhausted", () => {
    expect(SHED_ORDER[SHED_ORDER.length - 1]).toBe("prompt-raise-budget-or-unpin");
  });
});

describe("budget reduction preview", () => {
  let db: DatabaseSync;
  let index: ResidentSetIndex;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    index = createSqliteResidentSetIndex({ db });
  });

  async function seedIndexed(count: number, size: number, confirmed: boolean) {
    const peerStorage = new MockObjectStorageAdapter();
    await peerStorage.init();
    const hashes = new Map<string, string>();
    for (let i = 0; i < count; i++) {
      const data = Buffer.alloc(size, i + 1);
      const hash = hashOf(data);
      const key = keyFor(hash);
      hashes.set(key, hash);
      if (confirmed) await peerStorage.put(key, data, { checksumSha256: b64Of(data) });
      index.add(entry({ objectStorageKey: key, sizeBytes: size, lastOpenedAtMs: i }));
    }
    return {
      probes: [{ nodeId: "peer", storage: peerStorage }] as ReplicaProbe[],
      contentHashOf: (e: ResidentEntry) => hashes.get(e.objectStorageKey) ?? null,
    };
  }

  it("reports nothing to do when the class already fits", async () => {
    const s = await seedIndexed(5, 100, true);
    const preview = await previewBudgetReduction({
      budgetLineKey: CLASS_A,
      newBudgetBytes: 1000,
      index,
      durability: { minimumReplicas: 1 },
      ...s,
    });
    expect(preview.wouldEvictCount).toBe(0);
    expect(preview.refusal).toBeNull();
  });

  // The confirmation prompt's numbers: "12,431 originals will be removed; 47
  // kept because they are not yet confirmed elsewhere."
  it("separates what would go from what is held back, and says how much", async () => {
    const s = await seedIndexed(10, 100, true);
    const preview = await previewBudgetReduction({
      budgetLineKey: CLASS_A,
      newBudgetBytes: 500,
      index,
      durability: { minimumReplicas: 1 },
      ...s,
    });
    expect(preview.wouldEvictCount).toBeGreaterThan(0);
    expect(preview.wouldEvictBytes).toBe(preview.wouldEvictCount * 100);
    expect(preview.keptNotConfirmedCount).toBe(0);
  });

  it("holds back what is not confirmed elsewhere and reports it separately", async () => {
    const s = await seedIndexed(10, 100, false);
    const preview = await previewBudgetReduction({
      budgetLineKey: CLASS_A,
      newBudgetBytes: 500,
      index,
      durability: { minimumReplicas: 1 },
      ...s,
    });
    expect(preview.wouldEvictCount).toBe(0);
    expect(preview.keptNotConfirmedCount).toBeGreaterThan(0);
  });

  // The operator asked for a reduction. Quietly degrading into "keep
  // everything" would look like it worked.
  it("refuses outright when no peer is available to confirm anything", async () => {
    const s = await seedIndexed(10, 100, false);
    const preview = await previewBudgetReduction({
      budgetLineKey: CLASS_A,
      newBudgetBytes: 500,
      index,
      probes: [],
      durability: { minimumReplicas: 1 },
      contentHashOf: s.contentHashOf,
    });
    expect(preview.refusal).toMatch(/Nothing was removed/);
  });
});
