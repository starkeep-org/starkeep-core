/**
 * How a blob's namespace and rung are chosen.
 *
 * This is the file that decides whose budget a record's bytes come out of and
 * whether they count as re-derivable, so the cases below are mostly about what
 * an app **cannot** make happen. Two failures are specifically guarded:
 *
 *   - Only one app's ladder being legible, so every other app's derivatives
 *     fell through to the original class and were treated as irreplaceable
 *     last copies of user content.
 *   - An app choosing its own classification, and with it its own budget row
 *     and its own answer to "may this be deleted".
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MockObjectStorageAdapter, type DatabaseAdapter } from "@starkeep/storage-adapter";
import type { StarkeepId } from "@starkeep/protocol-primitives";
import {
  createResidencyManager,
  originalClassFor,
  UNCLASSIFIED_RUNG,
  type ResidencyManager,
} from "../src/residency-manager.js";
import type {
  BlobCandidate,
  NodeRetentionPolicy,
  ResidencyVerdict,
  ResolvedSizeClass,
} from "../src/residency-policy.js";

const MB = 1024 * 1024;

/**
 * The verdict a fetch-and-land would have produced for a class.
 *
 * `noteArrival` takes the whole verdict rather than the class alone, because the
 * verdict is where the *resolved* pin lives — the pins table and any matching
 * `effect: "pin"` rule, together. These cases are about classification, so they
 * hand over an unpinned one.
 */
function landedAs(sizeClass: ResolvedSizeClass): ResidencyVerdict {
  return { decision: "fetch", sizeClass, pinned: false, reason: "keep-all" };
}

const row = { keep: "all" as const, budgetBytes: 100 * MB };
const policy: NodeRetentionPolicy = {
  platform: { rows: { "original:image": row }, fallback: row },
  apps: {},
  appFallback: { rows: {}, fallback: row, totalBudgetBytes: 100 * MB },
};

/**
 * Labels keyed by record id, and no capture times.
 *
 * Two methods are reached and the rest of the adapter is deliberately absent
 * rather than stubbed — a stub would suggest this exercises more of it than it
 * does. `getMetadataByIds` answers empty because these cases are about
 * classification, and an absent capture date is the ordinary state of a record
 * whose metadata has not been derived yet.
 */
function adapterWithLabels(
  labels: Record<string, Array<{ appId: string; key: string; value: string }>>,
): DatabaseAdapter {
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

function candidate(over: Partial<BlobCandidate> = {}): BlobCandidate {
  return {
    recordId: "r1",
    objectStorageKey: "shared/image/aa/" + "a".repeat(64),
    sizeBytes: 1000,
    type: "image/jpeg",
    parentId: null,
    appId: null,
    originAppId: "photos",
    recencyAtMs: null,
    lastOpenedAtMs: null,
    ...over,
  };
}

describe("namespace resolution", () => {
  let manager: ResidencyManager;

  function build(
    sizeClassKeys: Record<string, string>,
    labels: Record<string, Array<{ appId: string; key: string; value: string }>> = {},
  ): ResidencyManager {
    return createResidencyManager({
      localDb: new DatabaseSync(":memory:") as never,
      databaseAdapter: adapterWithLabels(labels),
      localObjectStorage: new MockObjectStorageAdapter(),
      sizeClassKeys,
      isCloudNode: false,
      policy,
      durability: { minimumReplicas: 1 },
    });
  }

  beforeEach(() => {
    manager = build({ photos: "rendition" });
  });

  it("puts a record with no parent in the platform namespace", async () => {
    const cls = await manager.classOf(candidate({ parentId: null }));
    expect(cls).toEqual(originalClassFor("image/jpeg"));
    expect(cls.namespace).toBe("starkeep");
  });

  it("takes a derivative's namespace from the app that wrote the label", async () => {
    manager = build(
      { photos: "rendition" },
      { r1: [{ appId: "photos", key: "rendition", value: "image-medium" }] },
    );
    const cls = await manager.classOf(candidate({ parentId: "parent" }));
    expect(cls.qualified).toBe("photos:image-medium");
  });

  // Gap 1. With a single configured `{ appId, key }` this record matched
  // nothing, fell through to `original:<category>`, and a cheap thumbnail was
  // then treated as the last copy of something irreplaceable.
  it("reads a second app's ladder too, rather than calling it an original", async () => {
    manager = build(
      { photos: "rendition", sketcher: "derived-size" },
      { r1: [{ appId: "sketcher", key: "derived-size", value: "preview" }] },
    );
    const cls = await manager.classOf(candidate({ parentId: "parent" }));
    expect(cls).toMatchObject({ namespace: "sketcher", rung: "preview" });
  });

  it("keeps two apps' identically-named rungs apart", async () => {
    manager = build(
      { photos: "rendition", sketcher: "derived-size" },
      {
        a: [{ appId: "photos", key: "rendition", value: "medium" }],
        b: [{ appId: "sketcher", key: "derived-size", value: "medium" }],
      },
    );
    const first = await manager.classOf(candidate({ recordId: "a", parentId: "p" }));
    const second = await manager.classOf(candidate({ recordId: "b", parentId: "p" }));
    expect(first.qualified).not.toBe(second.qualified);
  });

  // Gap 2, and the rule the whole design rests on: **a label picks the rung,
  // never the namespace.** An app that labels someone else's key gets nothing —
  // `appId` on a label row is server-set, so it can only ever name itself.
  it("ignores a label written under another app's key", async () => {
    manager = build(
      { photos: "rendition" },
      // `sketcher` writing the key `rendition` does not make this Photos'
      // ladder: the key is matched against the *writing* app's declaration, and
      // sketcher declared none.
      { r1: [{ appId: "sketcher", key: "rendition", value: "image-medium" }] },
    );
    const cls = await manager.classOf(
      candidate({ parentId: "parent", originAppId: "photos" }),
    );
    // The record is Photos' because Photos created it — but the rung is
    // unclassified, because sketcher's label bought nothing.
    expect(cls.qualified).toBe(`photos:${UNCLASSIFIED_RUNG}`);
  });

  // The platform/app split is decided by `parentId`, not by a label. Otherwise
  // an app could label an original into a cheap, freely-evictable rung.
  it("will not let a label move an original out of the platform namespace", async () => {
    manager = build(
      { photos: "rendition" },
      { r1: [{ appId: "photos", key: "rendition", value: "image-thumb" }] },
    );
    const cls = await manager.classOf(candidate({ parentId: null }));
    expect(cls.namespace).toBe("starkeep");
  });

  // …and the converse: a derivative cannot be promoted into the protected tier
  // by withholding its label. It falls to whoever created the record.
  it("charges an unlabelled derivative to the app that created it", async () => {
    const cls = await manager.classOf(
      candidate({ parentId: "parent", originAppId: "sketcher" }),
    );
    expect(cls).toMatchObject({ namespace: "sketcher", rung: UNCLASSIFIED_RUNG });
  });

  // Nothing to attribute it to. Treated as an original, because the two
  // mistakes are not symmetric: calling an original re-derivable deletes it.
  it("falls back to the platform namespace when even the origin is unknown", async () => {
    const cls = await manager.classOf(
      candidate({ parentId: "parent", originAppId: null }),
    );
    expect(cls.namespace).toBe("starkeep");
  });

  // An app-syncable blob is unambiguously one app's own bytes, so it belongs
  // against that app's total rather than in a node-wide fallback nobody budgets.
  it("puts an app-syncable blob in its owning app's namespace", async () => {
    const cls = await manager.classOf(candidate({ appId: "notes" }));
    expect(cls).toMatchObject({ namespace: "notes", rung: UNCLASSIFIED_RUNG });
  });

  // Two apps labelling one derivative — the case this whole change exists to
  // support. `labels.find` answered it with whichever row the label read
  // happened to return first, which is not a rule and need not be the same
  // answer twice; the census then answered it a third way and counted the
  // record's bytes into both classes.
  describe("when several apps have labelled one derivative", () => {
    const twoLabels = {
      r1: [
        { appId: "sketcher", key: "derived-size", value: "preview" },
        { appId: "photos", key: "rendition", value: "medium" },
      ],
    };

    it("takes the class from the app that created the record", async () => {
      manager = build({ photos: "rendition", sketcher: "derived-size" }, twoLabels);
      const cls = await manager.classOf(
        candidate({ parentId: "parent", originAppId: "sketcher" }),
      );
      expect(cls.qualified).toBe("sketcher:preview");
    });

    it("falls back to the lowest app id when the origin labelled nothing", async () => {
      manager = build({ photos: "rendition", sketcher: "derived-size" }, twoLabels);
      const cls = await manager.classOf(
        candidate({ parentId: "parent", originAppId: "notes" }),
      );
      expect(cls.qualified).toBe("photos:medium");
    });

    // The property that matters more than which app wins: the same record
    // resolves to the same class every time, whatever order the labels arrive
    // in. An answer that moves charges a byte to two budgets and evicts it from
    // neither.
    it("gives the same answer whatever order the labels come back in", async () => {
      const keys = { photos: "rendition", sketcher: "derived-size" };
      const forward = await build(keys, twoLabels).classOf(
        candidate({ parentId: "parent", originAppId: null }),
      );
      const reversed = await build(keys, { r1: [...twoLabels.r1].reverse() }).classOf(
        candidate({ parentId: "parent", originAppId: null }),
      );
      expect(forward.qualified).toBe(reversed.qualified);
    });
  });

  it("assigns no rung for an app that declares no size-class key", async () => {
    manager = build(
      {},
      { r1: [{ appId: "photos", key: "rendition", value: "image-medium" }] },
    );
    const cls = await manager.classOf(candidate({ parentId: "parent" }));
    expect(cls.rung).toBe(UNCLASSIFIED_RUNG);
  });
});

describe("durability proof follows what can be re-derived, not the class name", () => {
  function build(labels: Record<string, Array<{ appId: string; key: string; value: string }>> = {}) {
    return createResidencyManager({
      localDb: new DatabaseSync(":memory:") as never,
      databaseAdapter: adapterWithLabels(labels),
      localObjectStorage: new MockObjectStorageAdapter(),
      sizeClassKeys: { photos: "rendition" },
      isCloudNode: false,
      policy,
      durability: { minimumReplicas: 1 },
    });
  }

  // This used to be a `startsWith("original:")` test on the class name — a
  // naming convention standing in for a structural fact, where a rename made
  // originals silently evictable.
  it("requires proof for anything in the platform namespace", async () => {
    const manager = build();
    const c = candidate({ parentId: null });
    await manager.noteArrival(c, landedAs(await manager.classOf(c)));
    expect(manager.index.get(c.objectStorageKey)!.requiresDurabilityProof).toBe(true);
  });

  it("does not require proof for a labelled derivative", async () => {
    const manager = build({ r1: [{ appId: "photos", key: "rendition", value: "image-medium" }] });
    const c = candidate({ parentId: "parent" });
    await manager.noteArrival(c, landedAs(await manager.classOf(c)));
    expect(manager.index.get(c.objectStorageKey)!.requiresDurabilityProof).toBe(false);
  });

  // An app-named rung called `original:image` is still the app's own bytes, and
  // still evictable. Under the old string test it would have claimed the
  // protected tier just by choosing the right word.
  it("is not fooled by an app naming a rung after the platform's", async () => {
    const manager = build({ r1: [{ appId: "photos", key: "rendition", value: "original:image" }] });
    const c = candidate({ parentId: "parent" });
    const cls = await manager.classOf(c);
    expect(cls.qualified).toBe("photos:original:image");
    await manager.noteArrival(c, landedAs(cls));
    expect(manager.index.get(c.objectStorageKey)!.requiresDurabilityProof).toBe(false);
  });

  // The case that makes "app namespace ⇒ re-derivable" wrong. An app-syncable
  // blob is one app's own bytes, so it is charged to that app's namespace and
  // total — but nothing derived it, this node may hold the only copy, and
  // reading proof off the namespace would let the eviction pass delete it with
  // no replica check at all.
  it("requires proof for an app-syncable blob, which nothing can re-derive", async () => {
    const manager = build();
    const c = candidate({ appId: "notes", parentId: null });
    const cls = await manager.classOf(c);
    expect(cls.qualified).toBe(`notes:${UNCLASSIFIED_RUNG}`);
    await manager.noteArrival(c, landedAs(cls));
    expect(manager.index.get(c.objectStorageKey)!.requiresDurabilityProof).toBe(true);
  });

  // A derivative nobody can attribute is classified as an original on purpose,
  // and the protection has to agree — otherwise the fail-closed branch in
  // `resolveClass` is fail-open by the time it reaches the index.
  it("requires proof for a derivative whose origin is unknown", async () => {
    const manager = build();
    const c = candidate({ parentId: "parent", originAppId: null });
    await manager.noteArrival(c, landedAs(await manager.classOf(c)));
    expect(manager.index.get(c.objectStorageKey)!.requiresDurabilityProof).toBe(true);
  });
});

describe("byte accounting is namespaced", () => {
  it("sums an app's bytes across its rungs, and keeps apps apart", async () => {
    const manager = createResidencyManager({
      localDb: new DatabaseSync(":memory:") as never,
      databaseAdapter: adapterWithLabels({
        a: [{ appId: "photos", key: "rendition", value: "thumb" }],
        b: [{ appId: "photos", key: "rendition", value: "medium" }],
        c: [{ appId: "sketcher", key: "derived-size", value: "preview" }],
      }),
      localObjectStorage: new MockObjectStorageAdapter(),
      sizeClassKeys: { photos: "rendition", sketcher: "derived-size" },
      isCloudNode: false,
      policy,
      durability: { minimumReplicas: 1 },
    });

    for (const [id, size] of [["a", 100], ["b", 250], ["c", 40]] as const) {
      const c = candidate({ recordId: id, objectStorageKey: id, sizeBytes: size, parentId: "p" });
      await manager.noteArrival(c, landedAs(await manager.classOf(c)));
    }

    expect(manager.usageByNamespace()).toEqual({ photos: 350, sketcher: 40 });
    expect(manager.usageByClass()).toEqual({
      "photos:thumb": 100,
      "photos:medium": 250,
      "sketcher:preview": 40,
    });
  });
});
