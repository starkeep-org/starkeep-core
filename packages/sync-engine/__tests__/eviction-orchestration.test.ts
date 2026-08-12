/**
 * The eviction *pass* — `ResidencyManager.runEviction` and the pieces only it
 * assembles.
 *
 * `eviction.test.ts` next door covers `evictLine` given a request. This file
 * covers the layer that builds those requests, which is where three separate
 * things live that nothing else has an opinion about: which lines a pass runs
 * over, the key-shape check that decides whether a blob can be verified at all,
 * and the departure/reconcile pair that keeps the index agreeing with the disk.
 *
 * The bar throughout is the one `eviction.test.ts` states: every case here that
 * asserts something is *kept* would delete a wanted object if the guard it
 * covers were removed.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MockObjectStorageAdapter, type DatabaseAdapter } from "@starkeep/storage-adapter";
import type { StarkeepId } from "@starkeep/protocol-primitives";
import {
  createResidencyManager,
  type ResidencyManager,
} from "../src/residency-manager.js";
import { assessDurability, MINIMUM_REPLICAS_FLOOR, type ReplicaProbe } from "../src/durability.js";
import type {
  BlobCandidate,
  NodeRetentionPolicy,
  ResidencyVerdict,
  SizeClassRetention,
} from "../src/residency-policy.js";

const MB = 1024 * 1024;

const hashOf = (b: Buffer) => createHash("sha256").update(b as unknown as Uint8Array).digest("hex");
const b64Of = (b: Buffer) => createHash("sha256").update(b as unknown as Uint8Array).digest("base64");
const keyFor = (hash: string) => `shared/image/${hash.slice(0, 2)}/${hash}`;

type Label = { appId: string; key: string; value: string };

function adapter(labels: Record<string, Label[]> = {}): DatabaseAdapter {
  return {
    async getLabelsByRecordIds(recordIds: StarkeepId[]) {
      const out = new Map<StarkeepId, never[]>();
      for (const id of recordIds) {
        out.set(
          id,
          (labels[id] ?? []).map((l) => ({ ...l, recordId: id, deletedAt: null })) as never[],
        );
      }
      return out as never;
    },
    async getMetadataByIds() {
      return new Map();
    },
  } as unknown as DatabaseAdapter;
}

const keepAll: SizeClassRetention = { prefetch: true, share: 1 };

/**
 * A platform namespace where `original:image` gets exactly `budgetBytes`.
 *
 * Shares divide one namespace budget across the declared rows *and* the pooled
 * fallback, so a suite that wants originals capped at a number has to say what
 * else is claiming a share. Nothing else is, here.
 */
const onlyOriginals = (budgetBytes: number) => ({
  rows: { "original:image": keepAll },
  fallback: { prefetch: true, share: 0 },
  budgetBytes,
});

/** The same, holding none of the class — what `keep: "never"` used to say. */
const noOriginals = () => ({
  rows: { "original:image": { prefetch: true, share: 0 } },
  fallback: keepAll,
  budgetBytes: 100 * MB,
});

function policyWith(over: Partial<NodeRetentionPolicy> = {}): NodeRetentionPolicy {
  return {
    platform: { rows: { "original:image": keepAll }, fallback: keepAll, budgetBytes: 100 * MB },
    apps: {},
    appFallback: { rows: {}, fallback: keepAll, budgetBytes: 100 * MB },
    ...over,
  };
}

interface Built {
  readonly manager: ResidencyManager;
  readonly storage: MockObjectStorageAdapter;
}

async function build(options: {
  policy?: NodeRetentionPolicy;
  labels?: Record<string, Label[]>;
} = {}): Promise<Built> {
  const storage = new MockObjectStorageAdapter();
  await storage.init();
  return {
    storage,
    manager: createResidencyManager({
      localDb: new DatabaseSync(":memory:") as never,
      databaseAdapter: adapter(options.labels),
      localObjectStorage: storage,
      sizeClassKeys: { photos: "rendition" },
      isCloudNode: false,
      policy: options.policy ?? policyWith(),
      durability: { minimumReplicas: 1 },
    }),
  };
}

/** A verdict standing in for one the policy produced, so `noteArrival` can charge it. */
function landed(qualified: string): ResidencyVerdict {
  const separator = qualified.indexOf(":");
  return {
    decision: "fetch",
    sizeClass: {
      namespace: qualified.slice(0, separator),
      rung: qualified.slice(separator + 1),
      qualified,
    },
    pinned: false,
    reason: "within-budget",
  };
}

/**
 * Land `count` blobs into a class, present locally and (optionally) on a peer.
 *
 * The bytes are real and content-addressed, because the durability probe reads
 * the store's own checksum and the key's shard has to agree with the hash — the
 * two facts half these cases are about.
 */
async function landBlobs(
  built: Built,
  options: {
    count: number;
    size: number;
    sizeClass: string;
    peer?: MockObjectStorageAdapter;
    parentId?: string | null;
    salt?: number;
  },
): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < options.count; i += 1) {
    const data = Buffer.alloc(options.size, ((options.salt ?? 0) * 101 + i + 1) % 251);
    const hash = hashOf(data);
    const key = keyFor(hash);
    keys.push(key);
    await built.storage.put(key, data);
    if (options.peer) await options.peer.put(key, data, { checksumSha256: b64Of(data) });
    await built.manager.noteArrival(
      {
        recordId: `r-${options.sizeClass}-${options.salt ?? 0}-${i}`,
        objectStorageKey: key,
        sizeBytes: options.size,
        type: "image/jpeg",
        parentId: options.parentId ?? null,
        appId: null,
        originAppId: "photos",
        recencyAtMs: null,
        lastOpenedAtMs: i,
      },
      landed(options.sizeClass),
    );
  }
  return keys;
}

async function newPeer(): Promise<MockObjectStorageAdapter> {
  const peer = new MockObjectStorageAdapter();
  await peer.init();
  return peer;
}

// ---------------------------------------------------------------------------
// r4 #14 — what runEviction runs, and in what order
// ---------------------------------------------------------------------------

describe("which lines runEviction runs over", () => {
  /**
   * There is no ordering left to get wrong, and that is the finding.
   *
   * This block used to assert "every class, then every non-platform namespace",
   * because a row carried an absolute byte count and an app carried a separate
   * total that could be breached while every row was comfortable. The namespace
   * pass had to run *second* so it worked against what the class passes had
   * already freed; reversed, it would have counted bytes that were about to go
   * anyway and over-evicted by exactly that much.
   *
   * Rows are shares of one namespace budget now, so the lines of a namespace
   * sum to it and a node inside every line is inside its namespace. One kind of
   * pass, no ordering constraint between passes, and one less way to be wrong.
   */
  it("runs one pass per budget line and no namespace pass at all", async () => {
    const built = await build({
      policy: policyWith({
        apps: {
          photos: {
            rows: { thumb: keepAll, medium: keepAll },
            fallback: keepAll,
            budgetBytes: 100 * MB,
          },
        },
      }),
    });
    const peer = await newPeer();
    await landBlobs(built, { count: 2, size: 100, sizeClass: "photos:thumb", peer, salt: 1 });
    await landBlobs(built, { count: 2, size: 100, sizeClass: "photos:medium", peer, salt: 2 });

    const keys = (await built.manager.runEviction([{ nodeId: "peer", storage: peer }]))
      .map((o) => o.budgetLine.key)
      .sort();
    // Every line the policy declares, plus each namespace's pooled fallback.
    // No entry names a namespace, because a namespace is no longer a budget.
    expect(keys).toEqual([
      "photos:*",
      "photos:medium",
      "photos:thumb",
      "starkeep:*",
      "starkeep:original:image",
    ]);
  });

  /**
   * Lines come from the policy *and* from what is held.
   *
   * The policy alone would miss a line whose rows an operator has since deleted
   * — bytes still on disk, now pooled into a fallback — and the index alone
   * would stop covering a line the moment it emptied, which is exactly when a
   * budget reduction wants a pass to run over it.
   */
  it("covers a declared line holding nothing, and a held line the policy forgot", async () => {
    const built = await build({
      policy: policyWith({
        platform: {
          rows: { "original:image": keepAll, "original:video": keepAll },
          fallback: keepAll,
          budgetBytes: 100 * MB,
        },
      }),
    });
    const peer = await newPeer();
    await landBlobs(built, { count: 1, size: 100, sizeClass: "starkeep:original:image", peer });

    const keys = (await built.manager.runEviction([{ nodeId: "peer", storage: peer }]))
      .map((o) => o.budgetLine.key)
      .sort();
    // `original:video` holds nothing and is still swept: a budget reduction is
    // most likely to be aimed at a line whose bytes are already gone.
    expect(keys).toContain("starkeep:original:video");
    expect(keys).toContain("starkeep:original:image");
  });

  it("sweeps every app's lines, and each only once", async () => {
    const built = await build({
      policy: policyWith({
        apps: {
          photos: { rows: {}, fallback: keepAll, budgetBytes: 100 * MB },
          sketcher: { rows: {}, fallback: keepAll, budgetBytes: 100 * MB },
        },
      }),
    });
    const peer = await newPeer();
    // Two invented rungs of one app, which pool onto a single line — so a loop
    // that keyed off the class rather than the line would run it twice and
    // report the second pass against bytes the first had already freed.
    await landBlobs(built, { count: 1, size: 100, sizeClass: "photos:thumb", peer, salt: 1 });
    await landBlobs(built, { count: 1, size: 100, sizeClass: "photos:medium", peer, salt: 4 });
    await landBlobs(built, { count: 1, size: 100, sizeClass: "sketcher:preview", peer, salt: 2 });

    const keys = (await built.manager.runEviction([{ nodeId: "peer", storage: peer }])).map(
      (o) => o.budgetLine.key,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("photos:*");
    expect(keys).toContain("sketcher:*");
  });
});

// ---------------------------------------------------------------------------
// r4 #15 — the key shape is what makes a replica verifiable
// ---------------------------------------------------------------------------

/**
 * `contentHashOfKey` returns null for anything that is not
 * `shared/<category>/<shard>/<sha256>`, and a null hash makes the pass refuse.
 *
 * Asserted through the pass rather than against the function, deliberately: the
 * function is private and the *consequence* is the property worth pinning. A
 * hash read off a key is what tells a correct replica from an object that merely
 * occupies the key, so "cannot parse the key" and "must not delete" have to be
 * the same answer. Each case below is a key that would have to be rejected for
 * that to hold.
 */
describe("a key whose shape yields no content hash", () => {
  /**
   * Land one blob at a caller-chosen key, over budget, with the bytes genuinely
   * present on a peer.
   *
   * The peer copy matters: without it every case here would pass for the
   * ordinary reason (nothing is confirmed anywhere), and the key-shape check
   * would never be reached. What makes these cases sharp is that the blob
   * *would* be evictable if its key could be parsed.
   */
  async function passOver(key: string): Promise<{
    evicted: number;
    keptReason: string | undefined;
  }> {
    const built = await build({
      policy: policyWith({
        platform: onlyOriginals(100),
      }),
    });
    const peer = await newPeer();
    const data = Buffer.alloc(1000, 3);
    await built.storage.put(key, data);
    await peer.put(key, data, { checksumSha256: b64Of(data) });
    await built.manager.noteArrival(
      {
        recordId: "r1",
        objectStorageKey: key,
        sizeBytes: 1000,
        type: "image/jpeg",
        parentId: null,
        appId: null,
        originAppId: "photos",
        recencyAtMs: null,
        lastOpenedAtMs: null,
      },
      landed("starkeep:original:image"),
    );

    const outcome = (await built.manager.runEviction([{ nodeId: "peer", storage: peer }]))[0]!;
    expect(outcome.triggered).toBe(true);
    return { evicted: outcome.evicted.length, keptReason: outcome.kept[0]?.reason };
  }

  const canonical = hashOf(Buffer.alloc(1000, 3));

  it.each([
    ["not under shared/", `local/image/${canonical.slice(0, 2)}/${canonical}`],
    ["too few segments", `shared/${canonical.slice(0, 2)}/${canonical}`],
    ["too many segments", `shared/image/x/${canonical.slice(0, 2)}/${canonical}`],
    // The shard exists to spread the keyspace, and a shard that disagrees with
    // the hash means the key was not built from these bytes — so whatever is at
    // it is not evidence about them.
    ["a shard that disagrees with the hash", `shared/image/zz/${canonical}`],
    // Hex is lowercase by construction. An uppercase one is a different string
    // that would compare unequal to the record's hash, so accepting it would be
    // accepting a comparison that can only fail.
    ["an uppercase hash", `shared/image/${canonical.slice(0, 2).toUpperCase()}/${canonical.toUpperCase()}`],
    ["a hash of the wrong length", `shared/image/ab/${canonical.slice(0, 40)}`],
    ["a non-hex hash", `shared/image/zz/${"z".repeat(64)}`],
  ])("refuses to evict a blob whose key is %s", async (_label, key) => {
    const { evicted, keptReason } = await passOver(key);
    expect(evicted).toBe(0);
    expect(keptReason).toBe("not-confirmed-elsewhere");
  });

  // The control: the same blob at a canonical key does go, so the cases above
  // are failing on the key shape and not on something incidental to the setup.
  it("evicts the same blob once its key is the canonical shape", async () => {
    const { evicted } = await passOver(keyFor(canonical));
    expect(evicted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// r4 #16 / N5 — a preview that cannot reach its target has to say so
// ---------------------------------------------------------------------------

describe("previewReduction against a class held up by pins", () => {
  /**
   * The finding: `held` includes pinned bytes and `evictionCandidates` excludes
   * them, so the preview computed a shortfall it had no way to name. It ran out
   * of candidates before reaching the target and reported `wouldEvictBytes`
   * short of the gap with `refusal: null` — which a confirmation prompt reads as
   * "confirm and this class will fit", when it will not.
   */
  it("reports the pinned bytes and flags the shortfall", async () => {
    const built = await build();
    const peer = await newPeer();
    const keys = await landBlobs(built, {
      count: 10,
      size: 100,
      sizeClass: "starkeep:original:image",
      peer,
    });
    // Eight of ten pinned: 800 bytes that no reduction can free.
    for (const key of keys.slice(0, 8)) built.manager.index.setPinned(key, true);

    const preview = await built.manager.previewReduction("starkeep:original:image", 500, [
      { nodeId: "peer", storage: peer },
    ]);

    expect(preview.unevictableBytes).toBe(800);
    // Everything on offer goes and the class still does not fit.
    expect(preview.wouldEvictBytes).toBe(200);
    expect(preview.shortfall).toBe(true);
  });

  it("does not flag a shortfall when the unpinned bytes are enough", async () => {
    const built = await build();
    const peer = await newPeer();
    const keys = await landBlobs(built, {
      count: 10,
      size: 100,
      sizeClass: "starkeep:original:image",
      peer,
    });
    built.manager.index.setPinned(keys[0]!, true);

    const preview = await built.manager.previewReduction("starkeep:original:image", 500, [
      { nodeId: "peer", storage: peer },
    ]);
    expect(preview.unevictableBytes).toBe(100);
    expect(preview.shortfall).toBe(false);
  });

  // The pass and the preview have to agree about this, or an operator confirms
  // one number and gets another.
  it("agrees with what the pass then refuses to delete", async () => {
    const built = await build({
      policy: policyWith({
        platform: onlyOriginals(500),
      }),
    });
    const peer = await newPeer();
    const keys = await landBlobs(built, {
      count: 10,
      size: 100,
      sizeClass: "starkeep:original:image",
      peer,
    });
    for (const key of keys.slice(0, 8)) built.manager.index.setPinned(key, true);

    const outcome = (await built.manager.runEviction([{ nodeId: "peer", storage: peer }]))[0]!;
    expect(outcome.shortfall).toBe(true);
    expect(outcome.evicted).toHaveLength(2);
    expect(built.manager.index.usageOf("starkeep:original:image")).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// r4 #17/#18 — departure, and reconciling the index against the disk
// ---------------------------------------------------------------------------

describe("noteDeparture", () => {
  async function oneBlob(): Promise<{ built: Built; key: string }> {
    const built = await build();
    const [key] = await landBlobs(built, {
      count: 1,
      size: 100,
      sizeClass: "starkeep:original:image",
    });
    return { built, key: key! };
  }

  it("stops the bytes counting toward the budget", async () => {
    const { built, key } = await oneBlob();
    expect(built.manager.usageByClass()["starkeep:original:image"]).toBe(100);
    built.manager.noteDeparture(key);
    expect(built.manager.usageByClass()["starkeep:original:image"] ?? 0).toBe(0);
  });

  // Departed, not forgotten. The row is the only durable record that this node
  // held these bytes and let them go, and `residencyOf` needs exactly that to
  // tell "declined, and the peer will offer it again" from "held, dropped, and
  // no sync round will ever send it again".
  it("keeps the row, so the node remembers it once held these bytes", async () => {
    const { built, key } = await oneBlob();
    built.manager.noteDeparture(key);
    expect(built.manager.wasEvicted(key)).toBe(true);
    expect(built.manager.index.get(key)?.resident).toBe(false);
  });

  it("stops offering the departed row as an eviction candidate", async () => {
    const { built, key } = await oneBlob();
    built.manager.noteDeparture(key);
    const candidates = built.manager.index.evictionCandidates({
      budgetLineKey: "starkeep:original:image",
      targetBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(candidates).toHaveLength(0);
  });

  // A record that was never here is not a record that departed. Answering
  // otherwise would make `residencyOf` report an unrecoverable state for bytes
  // the peer is still perfectly willing to send.
  it("says nothing about a key it never held", async () => {
    const { built } = await oneBlob();
    expect(built.manager.wasEvicted("shared/image/aa/never-seen")).toBe(false);
  });
});

describe("the index rebuild", () => {
  /**
   * R2's other half: the index counts only bytes that arrived by sync.
   *
   * A locally imported original, a rendition the deriver wrote, anything a
   * watcher put on disk — none of them touch `noteArrival`, so none of them are
   * charged to any budget. `reconcile` is the walk that finds both directions of
   * disagreement, and only one of them can be fixed here.
   */
  it("marks departed the rows storage no longer has", async () => {
    const built = await build();
    const keys = await landBlobs(built, {
      count: 3,
      size: 100,
      sizeClass: "starkeep:original:image",
    });
    // Bytes removed behind the index's back — a crash between the delete and
    // the index write, a user clearing app data, a partial restore.
    await built.storage.delete(keys[0]!);

    const report = await built.manager.reconcile();
    expect(report.confirmed).toBe(2);
    expect(report.corrected).toBe(1);
    expect(built.manager.index.get(keys[0]!)?.resident).toBe(false);
    expect(built.manager.usageByClass()["starkeep:original:image"]).toBe(200);
  });

  /**
   * Reported rather than adopted, and the distinction is the design.
   *
   * Adopting a key means answering "whose budget do these bytes come out of",
   * and that needs the record row — which only the host can join. The index must
   * not learn what a size class is, so it hands the keys back and a host that
   * can resolve them calls `add`.
   */
  it("reports keys storage holds that no budget knows about", async () => {
    const built = await build();
    await landBlobs(built, { count: 1, size: 100, sizeClass: "starkeep:original:image" });
    await built.storage.put("shared/image/bb/imported-by-hand", Buffer.alloc(50, 9));

    const report = await built.manager.reconcile();
    expect(report.unknownKeys).toEqual(["shared/image/bb/imported-by-hand"]);
    // Not adopted: the budget is unchanged, because nothing here could say which
    // budget it belongs to.
    expect(built.manager.usageByClass()["starkeep:original:image"]).toBe(100);
  });

  // The direction that matters for safety. An unknown key is *invisible* to the
  // eviction pass rather than unprotected — the pass draws its candidates from
  // the index — so the gap costs disk, not data.
  it("leaves an unknown key out of the eviction pass entirely", async () => {
    const built = await build({
      policy: policyWith({
        platform: onlyOriginals(1),
      }),
    });
    const peer = await newPeer();
    await landBlobs(built, { count: 2, size: 100, sizeClass: "starkeep:original:image", peer });
    await built.storage.put("shared/image/bb/imported-by-hand", Buffer.alloc(50, 9));

    await built.manager.runEviction([{ nodeId: "peer", storage: peer }]);
    expect(await built.storage.has("shared/image/bb/imported-by-hand")).toBe(true);
  });

  // A reconcile is the one operation that walks storage, so a reservation must
  // not be mistaken for a landed row that storage has lost. It has not arrived
  // yet; that is the whole point of it.
  it("does not correct a reservation that has not landed", async () => {
    const built = await build();
    built.manager.reserve(
      {
        recordId: "r-reserved",
        objectStorageKey: "shared/image/cc/" + "c".repeat(64),
        sizeBytes: 400,
        type: "image/jpeg",
        parentId: null,
        appId: null,
        originAppId: "photos",
        recencyAtMs: null,
        lastOpenedAtMs: null,
      },
      landed("starkeep:original:image"),
    );
    const report = await built.manager.reconcile();
    expect(report.corrected).toBe(0);
    expect(built.manager.usageByClass()["starkeep:original:image"]).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// r4 #12 — a class the operator switched off
// ---------------------------------------------------------------------------

describe("a class whose share is zero", () => {
  /**
   * N2's consequence at the eviction end, and why it is now unrepresentable.
   *
   * The pass refuses to run against a non-finite budget — correctly, since a
   * budget that is not a number is not a small budget but no answer at all —
   * and `{ keep: "never" }` with no `budgetBytes` used to validate. So the one
   * class an operator had just set to "keep nothing" became the one class the
   * pass would never touch, and a whole normalization step existed to break the
   * tie between a rule and a budget that contradicted it.
   *
   * A share of zero *is* a budget of zero. There is no second field to omit and
   * no rule beside it to disagree with, so the case can no longer be written.
   * What still has to hold is the behaviour: zero empties the line.
   */
  it("is emptied rather than exempted", async () => {
    const built = await build({
      policy: policyWith({
        platform: noOriginals(),
      }),
    });
    const peer = await newPeer();
    await landBlobs(built, { count: 5, size: 100, sizeClass: "starkeep:original:image", peer });

    const outcome = (await built.manager.runEviction([{ nodeId: "peer", storage: peer }]))[0]!;
    expect(outcome.triggered).toBe(true);
    expect(built.manager.usageByClass()["starkeep:original:image"] ?? 0).toBe(0);
  });

  // Zero is a real answer and must not be confused with the missing one above:
  // every comparison against a NaN is false, so the pass would trigger and then
  // never reach its target, while a real zero triggers and empties the line —
  // which is the point.
  it("is emptied all the way rather than down to a water mark", async () => {
    const built = await build({
      policy: policyWith({
        platform: noOriginals(),
      }),
    });
    const peer = await newPeer();
    await landBlobs(built, { count: 5, size: 100, sizeClass: "starkeep:original:image", peer });

    await built.manager.runEviction([{ nodeId: "peer", storage: peer }]);
    expect(built.manager.usageByClass()["starkeep:original:image"] ?? 0).toBe(0);
  });

  // …and it still will not delete a last copy. A zero share is a statement
  // about this node's disk, not permission to lose the bytes.
  it("still refuses anything no peer can confirm", async () => {
    const built = await build({
      policy: policyWith({
        platform: noOriginals(),
      }),
    });
    await landBlobs(built, { count: 5, size: 100, sizeClass: "starkeep:original:image" });

    const outcome = (await built.manager.runEviction([]))[0]!;
    expect(outcome.evicted).toHaveLength(0);
    expect(outcome.refusal).toMatch(/no peer is available/);
    expect(built.manager.usageByClass()["starkeep:original:image"]).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// r3 18a–18e / r4 #19–23 — the durability predicate at the pass's boundary
// ---------------------------------------------------------------------------

describe("the durability floor", () => {
  const data = Buffer.alloc(64, 5);
  const query = {
    objectStorageKey: keyFor(hashOf(data)),
    contentHash: hashOf(data),
    sizeBytes: data.length,
  };

  /**
   * `minimumReplicas: 0` is clamped rather than honoured.
   *
   * The predicate is `counted >= minimumReplicas`. At zero that is true for
   * every blob with **zero probes and zero evidence** — every deletion
   * authorized, nothing asked — and the number arrives from a JSON config file
   * where nothing validated it. The field's own documentation calls itself "the
   * only thing that keeps that from being a data-loss feature", which is exactly
   * the kind of claim that must not depend on every caller remembering to clamp.
   */
  it.each([
    ["zero", 0],
    ["negative", -5],
    ["NaN", Number.NaN],
  ])("refuses to authorize a deletion on a minimum of %s", async (_label, minimumReplicas) => {
    const verdict = await assessDurability(query, [], { minimumReplicas });
    expect(verdict.durable).toBe(false);
    // And it reports the threshold it actually used, so a caller inspecting the
    // verdict sees the clamp rather than the value it passed in.
    expect(verdict.minimumRequired).toBe(MINIMUM_REPLICAS_FLOOR);
  });

  it("honours a minimum above the floor", async () => {
    const verdict = await assessDurability(query, [], { minimumReplicas: 3 });
    expect(verdict.minimumRequired).toBe(3);
  });

  // The end-to-end shape of the same guarantee: a pass configured with a zero
  // minimum and no probes at all deletes nothing.
  it("stops a zero-minimum pass from emptying a class on no evidence", async () => {
    const storage = new MockObjectStorageAdapter();
    await storage.init();
    const manager = createResidencyManager({
      localDb: new DatabaseSync(":memory:") as never,
      databaseAdapter: adapter(),
      localObjectStorage: storage,
      sizeClassKeys: {},
      isCloudNode: false,
      policy: policyWith({
        platform: onlyOriginals(1),
      }),
      durability: { minimumReplicas: 0 },
    });
    const built = { manager, storage };
    const keys = await landBlobs(built, {
      count: 5,
      size: 100,
      sizeClass: "starkeep:original:image",
    });

    const outcome = (await manager.runEviction([]))[0]!;
    expect(outcome.evicted).toHaveLength(0);
    for (const key of keys) expect(await storage.has(key)).toBe(true);
  });
});

describe("what the pass does when it cannot ask anyone", () => {
  /**
   * `EvictionOutcome.refusal` — the sentence the preview always had and the pass
   * that actually deletes did not.
   *
   * The loop was saved from deleting on no evidence only by the arithmetic in
   * `assessDurability` — `counted >= minimum` is false at zero probes *as long
   * as* the minimum is at least one — which is precisely the invariant the floor
   * had to be introduced to hold. A guarantee that emerges from arithmetic
   * happening elsewhere is one nobody can see, and a shortfall with no reason
   * attached is what an operator was left with.
   */
  it("deletes nothing and says why", async () => {
    const built = await build({
      policy: policyWith({
        platform: onlyOriginals(100),
      }),
    });
    const keys = await landBlobs(built, {
      count: 5,
      size: 100,
      sizeClass: "starkeep:original:image",
    });

    const outcome = (await built.manager.runEviction([]))[0]!;
    expect(outcome.evicted).toHaveLength(0);
    expect(outcome.shortfall).toBe(true);
    expect(outcome.refusal).toMatch(/no peer is available to confirm/);
    // It names how many blobs were held back, which is the number that makes
    // the sentence actionable.
    expect(outcome.refusal).toMatch(/5 blob\(s\)/);
    for (const key of keys) expect(await built.storage.has(key)).toBe(true);
  });

  // Nothing to refuse is not a refusal. A pass that had no probes and needed
  // none must not manufacture a warning an operator would have to dismiss.
  it("reports no refusal when nothing needed proof", async () => {
    const built = await build({
      policy: policyWith({
        platform: onlyOriginals(100 * MB),
      }),
    });
    await landBlobs(built, { count: 2, size: 100, sizeClass: "starkeep:original:image" });
    const outcome = (await built.manager.runEviction([]))[0]!;
    expect(outcome.triggered).toBe(false);
    expect(outcome.refusal).toBeNull();
  });

  /**
   * Every probe failing is not the same as having no probes, and both must keep
   * the bytes.
   *
   * "I could not tell" is the rule this whole branch is built around, and it
   * appears here as: a probe that throws is neither evidence of presence nor
   * evidence of absence. The reported shortfall is the second half — a pass that
   * kept everything and reported success would leave a full disk looking healthy.
   */
  it("keeps everything, and reports the shortfall, when every probe fails", async () => {
    const built = await build({
      policy: policyWith({
        platform: onlyOriginals(100),
      }),
    });
    await landBlobs(built, { count: 5, size: 100, sizeClass: "starkeep:original:image" });

    const broken: ReplicaProbe = {
      nodeId: "broken",
      storage: {
        ...new MockObjectStorageAdapter(),
        stat: async () => {
          throw new Error("[test] network down");
        },
      } as unknown as MockObjectStorageAdapter,
    };

    const outcome = (await built.manager.runEviction([broken]))[0]!;
    expect(outcome.evicted).toHaveLength(0);
    expect(outcome.shortfall).toBe(true);
    expect(outcome.kept.every((k) => k.reason === "not-confirmed-elsewhere")).toBe(true);
    // Not a no-probe refusal: a probe was available and answered nothing useful,
    // which is a different sentence with a different remedy.
    expect(outcome.refusal).toBeNull();
    expect(outcome.corruptionSuspected).toEqual([]);
  });

  /**
   * A probe answering `absent` for a key the local node is holding.
   *
   * This is the ordinary case for a phone whose photos have not been uploaded
   * yet, and it must read as "the peer does not have it" rather than as anything
   * else. `absent` counts as nothing at all — not as evidence, and not as an
   * error worth suppressing the pass over.
   */
  it("keeps a blob the peer does not have", async () => {
    const built = await build({
      policy: policyWith({
        platform: onlyOriginals(100),
      }),
    });
    const keys = await landBlobs(built, {
      count: 5,
      size: 100,
      sizeClass: "starkeep:original:image",
    });
    // A peer that is perfectly reachable and simply holds nothing.
    const empty = await newPeer();

    const outcome = (await built.manager.runEviction([{ nodeId: "peer", storage: empty }]))[0]!;
    expect(outcome.evicted).toHaveLength(0);
    expect(outcome.kept.every((k) => k.reason === "not-confirmed-elsewhere")).toBe(true);
    for (const key of keys) expect(await built.storage.has(key)).toBe(true);
    // Empty-handed is not corrupt, and must not be reported as such — a
    // corruption report is meant to reach a human.
    expect(outcome.corruptionSuspected).toEqual([]);
  });

  // The control for the three cases above: with a peer that genuinely has the
  // bytes, the same class does empty down to its low-water mark. Without this,
  // every assertion above could be satisfied by a pass that never evicts.
  it("does evict once a peer actually confirms the bytes", async () => {
    const built = await build({
      policy: policyWith({
        platform: onlyOriginals(500),
      }),
    });
    const peer = await newPeer();
    await landBlobs(built, { count: 5, size: 100, sizeClass: "starkeep:original:image", peer });

    const outcome = (await built.manager.runEviction([{ nodeId: "peer", storage: peer }]))[0]!;
    expect(outcome.evicted.length).toBeGreaterThan(0);
    expect(outcome.shortfall).toBe(false);
    expect(outcome.refusal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// r4 #13 / N6 — one budget across engines that tick independently
// ---------------------------------------------------------------------------

describe("two engines sharing one manager", () => {
  const budget = 1000;
  const smallClass = policyWith({
    platform: onlyOriginals(budget),
  });

  function pending(id: string, sizeBytes: number): BlobCandidate {
    return {
      recordId: id,
      objectStorageKey: `shared/image/aa/${id}`,
      sizeBytes,
      type: "image/jpeg",
      parentId: null,
      appId: null,
      originAppId: "photos",
      recencyAtMs: null,
      lastOpenedAtMs: null,
    };
  }

  /**
   * The finding: the accounting used to move on *arrival*, which is right within
   * one engine — its inbound loop is strictly sequential, so each decision sees
   * the previous arrival — and wrong across engines. The supervisor hands one
   * index to the Drive engine and to every per-app engine, each with its own
   * timer, so two ticking at once both read `usageOf`, both see room, and both
   * land. The overshoot is roughly `(engines - 1) x largest blob`.
   */
  it("does not both see the same room", async () => {
    const built = await build({ policy: smallClass });
    const first = pending("a", 600);
    const second = pending("b", 600);

    // Engine one decides and reserves; engine two then decides, before either
    // transfer has finished.
    const firstVerdict = await built.manager.decide(first);
    expect(firstVerdict.decision).toBe("fetch");
    built.manager.reserve(first, firstVerdict);

    const secondVerdict = await built.manager.decide(second);
    expect(secondVerdict.decision).toBe("elide");
    expect(secondVerdict.reason).toBe("budget-exhausted");
  });

  it("charges the reservation to the budget before the bytes land", async () => {
    const built = await build({ policy: smallClass });
    const c = pending("a", 600);
    built.manager.reserve(c, await built.manager.decide(c));
    expect(built.manager.usageByClass()["starkeep:original:image"]).toBe(600);
  });

  // A reservation that outlived its transfer would be a permanent phantom charge
  // against the budget — the class would shrink a little on every failed fetch
  // and never recover.
  it("gives the room back when the transfer does not happen", async () => {
    const built = await build({ policy: smallClass });
    const first = pending("a", 600);
    const firstVerdict = await built.manager.decide(first);
    built.manager.reserve(first, firstVerdict);
    built.manager.releaseReservation(first.objectStorageKey);

    const second = pending("b", 600);
    expect((await built.manager.decide(second)).decision).toBe("fetch");
    expect(built.manager.usageByClass()["starkeep:original:image"] ?? 0).toBe(0);
  });

  // The arrival replaces the reservation rather than adding to it. Double
  // counting here would be the same overshoot in the other direction: a class
  // reporting twice what it holds and evicting to correct it.
  it("does not double-count once the bytes actually land", async () => {
    const built = await build({ policy: smallClass });
    const c = pending("a", 600);
    const verdict = await built.manager.decide(c);
    built.manager.reserve(c, verdict);
    await built.manager.noteArrival(c, verdict);
    expect(built.manager.usageByClass()["starkeep:original:image"]).toBe(600);
  });

  // A reservation is provisional and must never be offered for deletion — it
  // names bytes that are not there yet, so "evicting" one would delete nothing
  // and free nothing while reporting that it had.
  it("never offers a reservation as an eviction candidate", async () => {
    const built = await build({ policy: smallClass });
    const c = pending("a", 600);
    built.manager.reserve(c, await built.manager.decide(c));
    expect(
      built.manager.index.evictionCandidates({
        budgetLineKey: "starkeep:original:image",
        targetBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).toHaveLength(0);
  });
});
