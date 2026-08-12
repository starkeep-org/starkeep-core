/**
 * `ResidencyManager.decide` — the seam between the host's facts and the
 * platform's rule.
 *
 * Round 4's largest single hole was that this function was called by **no test
 * in either repository**. Everything under it was covered: `decideResidency` has
 * its own suite, `resolveSizeClass` has one, the override rules have one. What
 * nothing exercised was the wiring — which host input reaches which parameter —
 * and every finding in this area was a wiring fault rather than a logic fault:
 *
 *   - an `exclude` rule routed through the wrong parameter would have lost to a
 *     pin, silently inverting the one ordering the policy calls non-negotiable;
 *   - a rule-derived pin reached the decision and not the resident-set row, so
 *     the pass that deletes bytes could not see the rule that kept them (N4);
 *   - `recencyAtMs` was hard-coded null at every construction site, so the
 *     recency dimension could never bind at all (N1).
 *
 * All three are invisible from either side of the seam alone.
 *
 * N1's dimension is no longer a *policy* axis — a hand-written date cutoff was
 * a prediction of what the eviction ordering computes anyway, and it has been
 * deleted. The date it read is still the ordering's last term, so the wiring
 * this suite covers matters as much as it did; it now shows up as which blob
 * gets displaced rather than as which one gets declined.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MockObjectStorageAdapter, type DatabaseAdapter } from "@starkeep/storage-adapter";
import type { StarkeepId } from "@starkeep/protocol-primitives";
import {
  createResidencyManager,
  NO_CLOUD_LABEL_KEY,
  STARKEEP_LABEL_APP_ID,
  type ResidencyManager,
} from "../src/residency-manager.js";
import type { OverrideRule } from "../src/override-rules.js";
import type {
  BlobCandidate,
  NodeRetentionPolicy,
  SizeClassRetention,
} from "../src/residency-policy.js";

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

type Label = { appId: string; key: string; value: string };

const keepAll: SizeClassRetention = { prefetch: true, share: 1 };

/**
 * A namespace holding one class, sized so that class gets exactly `budgetBytes`.
 *
 * Shares divide a namespace budget across its declared rows *and* its pooled
 * fallback, so a test that wants a class capped at 500 bytes has to say how big
 * the namespace is and what else is claiming a share of it. Here the fallback
 * gets nothing, so the one row gets the lot.
 */
function onlyClass(rung: string, budgetBytes: number) {
  return {
    rows: { [rung]: keepAll },
    fallback: { prefetch: true, share: 0 },
    budgetBytes,
  };
}

function policyWith(over: Partial<NodeRetentionPolicy> = {}): NodeRetentionPolicy {
  return {
    platform: {
      rows: { "original:image": keepAll },
      fallback: keepAll,
      budgetBytes: 100 * MB,
    },
    apps: {},
    appFallback: { rows: {}, fallback: keepAll, budgetBytes: 100 * MB },
    ...over,
  };
}

/**
 * Labels, capture times, and record rows keyed by record id.
 *
 * `getMetadataByIds` answers for real here, unlike the classification suite next
 * door: the ordering terms are the point of half these cases, and a stub
 * returning an empty map is exactly the state N1 describes — the decider reading
 * null for every candidate, so every one of them ties.
 *
 * `get` answers too, because a derived record reads its *parent's* capture date
 * and there is no other way to find out what type the parent is.
 */
function adapter(
  labels: Record<string, Label[]> = {},
  capturedAt: Record<string, string> = {},
  records: Record<string, { type: string } | null> = {},
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
    async getMetadataByIds(_typeId: string, recordIds: StarkeepId[]) {
      const out = new Map<StarkeepId, Record<string, unknown>>();
      for (const id of recordIds) {
        const at = capturedAt[id];
        if (at !== undefined) out.set(id, { captured_at: at });
      }
      return out as never;
    },
    async get(id: StarkeepId) {
      return (records[id] ?? null) as never;
    },
  } as unknown as DatabaseAdapter;
}

interface BuildOptions {
  readonly labels?: Record<string, Label[]>;
  readonly capturedAt?: Record<string, string>;
  readonly records?: Record<string, { type: string } | null>;
  readonly policy?: NodeRetentionPolicy;
  readonly overrideRules?: readonly OverrideRule[];
  readonly isCloudNode?: boolean;
}

function build(options: BuildOptions = {}): ResidencyManager {
  return createResidencyManager({
    localDb: new DatabaseSync(":memory:") as never,
    databaseAdapter: adapter(options.labels, options.capturedAt, options.records),
    localObjectStorage: new MockObjectStorageAdapter(),
    sizeClassKeys: { photos: "rendition" },
    ...(options.overrideRules ? { overrideRules: options.overrideRules } : {}),
    isCloudNode: options.isCloudNode ?? false,
    policy: options.policy ?? policyWith(),
    durability: { minimumReplicas: 1 },
  });
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

// ---------------------------------------------------------------------------
// r4 #1 — an exclude rule is a constraint, not a negative pin
// ---------------------------------------------------------------------------

describe("an exclude rule beats a pin", () => {
  const excludeRule: OverrideRule = {
    appId: "photos",
    key: "sensitive",
    effect: "exclude",
  };
  const labels = { r1: [{ appId: "photos", key: "sensitive", value: "yes" }] };

  it("declines even when the record is pinned in the table", async () => {
    const manager = build({ labels, overrideRules: [excludeRule] });
    manager.setPinned("r1", true);

    const verdict = await manager.decide(candidate());

    // Which *parameter* the exclusion travelled through is the whole finding.
    // `decideResidency` checks `constraints` first and `overrides.pinned`
    // second, in a fixed order it describes as non-negotiable; routing an
    // exclude through `overrides` instead would have made it a negative pin,
    // losing every tie to a positive one.
    expect(verdict.decision).toBe("elide");
    expect(verdict.reason).toBe("record-constraint");
  });

  it("still reports the record as pinned, so nothing forgets the user asked", async () => {
    const manager = build({ labels, overrideRules: [excludeRule] });
    manager.setPinned("r1", true);

    // Declined *and* pinned is not a contradiction: the pin is a preference the
    // node holds and the constraint is a rule the record carries. Dropping the
    // pin from the verdict here would make an inspector show "not pinned" for a
    // record the user pinned by hand.
    expect((await manager.decide(candidate())).pinned).toBe(true);
  });

  it("does not decline a record the rule does not match", async () => {
    const manager = build({
      labels: { r1: [{ appId: "photos", key: "mundane", value: "yes" }] },
      overrideRules: [excludeRule],
    });
    expect((await manager.decide(candidate())).decision).toBe("fetch");
  });
});

// ---------------------------------------------------------------------------
// r4 #2 — a pins-table row observed in a decision
// ---------------------------------------------------------------------------

describe("the local_pins table reaches the decision", () => {
  // A budget one byte short of the candidate, so the *only* thing that can
  // produce a fetch is the pin. Asserting against a policy that would have
  // fetched anyway proves nothing about the wiring.
  const tight = policyWith({ platform: onlyClass("original:image", 500) });

  it("makes a pinned record fetch past a full budget", async () => {
    const manager = build({ policy: tight });
    expect((await manager.decide(candidate({ sizeBytes: 1000 }))).reason).toBe(
      "budget-exhausted",
    );

    manager.setPinned("r1", true);
    const verdict = await manager.decide(candidate({ sizeBytes: 1000 }));
    expect(verdict.decision).toBe("fetch");
    expect(verdict.reason).toBe("pinned");
  });

  it("stops applying once the pin is removed", async () => {
    const manager = build({ policy: tight });
    manager.setPinned("r1", true);
    manager.setPinned("r1", false);
    expect((await manager.decide(candidate({ sizeBytes: 1000 }))).decision).toBe("elide");
  });

  // Pins are per record, and the table is keyed that way. A pin that leaked
  // across records would silently exempt a whole library from its budget.
  it("applies to the pinned record only", async () => {
    const manager = build({ policy: tight });
    manager.setPinned("r1", true);
    const other = await manager.decide(candidate({ recordId: "r2", sizeBytes: 1000 }));
    expect(other.decision).toBe("elide");
  });
});

// ---------------------------------------------------------------------------
// r4 #3 — no-cloud is about the cloud, and only the host knows which node it is
// ---------------------------------------------------------------------------

describe("starkeep/no-cloud, evaluated against this node's identity", () => {
  const labels = {
    r1: [{ appId: STARKEEP_LABEL_APP_ID, key: NO_CLOUD_LABEL_KEY, value: "" }],
  };

  it("declines on the cloud node", async () => {
    const manager = build({ labels, isCloudNode: true });
    const verdict = await manager.decide(candidate());
    expect(verdict.decision).toBe("elide");
    expect(verdict.reason).toBe("record-constraint");
  });

  // The other half, and the one that makes the flag a privacy preference rather
  // than data loss: a laptop or a phone may hold these bytes freely. Reading the
  // label as "nobody may hold this" would leave the only copy in the cloud the
  // user just forbade.
  it("does not decline on a laptop or a phone", async () => {
    const manager = build({ labels, isCloudNode: false });
    expect((await manager.decide(candidate())).decision).toBe("fetch");
  });

  // A fetch-time decision cannot stop an inbound *push*, which is why the
  // constraint also needs the server-side refusal in `api-handler.ts`. Recorded
  // here so the seam's own coverage does not read as complete protection.
  it("is a fetch-time refusal only — the push path is the server's to refuse", async () => {
    const manager = build({ labels, isCloudNode: true });
    const verdict = await manager.decide(candidate());
    // Nothing here prevents the bytes arriving; it only declines to ask for
    // them. The pair is what holds.
    expect(verdict.decision).toBe("elide");
  });

  it("ignores a no-cloud label written by an app rather than the platform", async () => {
    const manager = build({
      labels: { r1: [{ appId: "photos", key: NO_CLOUD_LABEL_KEY, value: "" }] },
      isCloudNode: true,
    });
    // `appId` on a label row is server-set, so this is an app annotating its own
    // namespace — not the platform constraint, and it must not act like one.
    expect((await manager.decide(candidate())).decision).toBe("fetch");
  });
});

// ---------------------------------------------------------------------------
// r4 #4 — the budget is measured against this manager's own index
// ---------------------------------------------------------------------------

describe("usage is read from the index the manager owns", () => {
  const smallClass = policyWith({ platform: onlyClass("original:image", 2500) });

  function landed(manager: ResidencyManager, id: string, sizeBytes: number) {
    const c = candidate({ recordId: id, objectStorageKey: `key-${id}`, sizeBytes });
    return manager.noteArrival(c, {
      decision: "fetch",
      sizeClass: { namespace: "starkeep", rung: "original:image", qualified: "starkeep:original:image" },
      pinned: false,
      reason: "within-budget",
    });
  }

  it("declines once earlier arrivals have filled the class", async () => {
    const manager = build({ policy: smallClass });
    expect((await manager.decide(candidate({ sizeBytes: 1000 }))).decision).toBe("fetch");

    await landed(manager, "a", 1000);
    await landed(manager, "b", 1000);

    const verdict = await manager.decide(candidate({ recordId: "c", sizeBytes: 1000 }));
    expect(verdict.decision).toBe("elide");
    expect(verdict.reason).toBe("budget-exhausted");
  });

  /**
   * What used to need a second, independently-checked namespace total.
   *
   * Three rungs the policy has never heard of, each escaping into the app's
   * fallback. Under per-rung absolute budgets that bought three budgets, which
   * is exactly why a namespace-wide cap had to exist to bound it. They now share
   * one pooled line, so the third is declined by the *same* budget check as the
   * first two rather than by a separate gate with its own failure mode and its
   * own eviction pass.
   */
  it("pools every unrecognised rung of an app onto one budget", async () => {
    const manager = build({
      policy: policyWith({
        apps: {
          photos: {
            rows: {},
            fallback: { prefetch: true, share: 1 },
            budgetBytes: 2500,
          },
        },
      }),
      labels: {
        a: [{ appId: "photos", key: "rendition", value: "one" }],
        b: [{ appId: "photos", key: "rendition", value: "two" }],
        c: [{ appId: "photos", key: "rendition", value: "three" }],
      },
      records: { p: { type: "image/jpeg" } },
    });

    for (const id of ["a", "b"]) {
      const c = candidate({ recordId: id, objectStorageKey: `key-${id}`, sizeBytes: 1000, parentId: "p" });
      await manager.noteArrival(c, await manager.decide(c));
    }

    const verdict = await manager.decide(
      candidate({ recordId: "c", sizeBytes: 1000, parentId: "p" }),
    );
    expect(verdict.reason).toBe("budget-exhausted");
    // Three different class names, one budget line between them — which is the
    // property that makes inventing rung names cheap instead of free.
    expect(verdict.budgetLine?.key).toBe("photos:*");
    expect(manager.usageByNamespace()["photos"]).toBe(2000);
  });

  it("frees the budget again once the bytes depart", async () => {
    const manager = build({ policy: smallClass });
    await landed(manager, "a", 1000);
    await landed(manager, "b", 1000);
    manager.noteDeparture("key-a");
    // Departed is a state rather than a deletion (R2/R6), so this asserts that
    // a departed row stops being charged rather than merely stopping existing.
    expect((await manager.decide(candidate({ recordId: "c", sizeBytes: 1000 }))).decision).toBe(
      "fetch",
    );
  });
});

// ---------------------------------------------------------------------------
// r4 #5 — N4: a rule-derived pin has to reach the resident-set row
// ---------------------------------------------------------------------------

describe("a pin that came from a rule, not from the table", () => {
  const pinRule: OverrideRule = {
    appId: "photos",
    key: "faces",
    value: "ada",
    effect: "pin",
  };
  const labels = { r1: [{ appId: "photos", key: "faces", value: "ada" }] };

  it("makes the decision fetch past a full budget", async () => {
    const manager = build({
      labels,
      overrideRules: [pinRule],
      policy: policyWith({ platform: onlyClass("original:image", 500) }),
    });
    const verdict = await manager.decide(candidate({ sizeBytes: 1000 }));
    expect(verdict.decision).toBe("fetch");
    expect(verdict.reason).toBe("pinned");
  });

  /**
   * The regression itself.
   *
   * `noteArrival` used to re-read the pins table alone, so this record — fetched
   * past its budget *because* a rule said to keep it — landed with `pinned = 0`.
   * From there the eviction pass offered it, its belt-and-braces re-check read
   * the same column and agreed, and the census reported zero pinned bytes: the
   * rule that made the node fetch the photo was invisible to everything that
   * might delete it.
   */
  it("reaches the resident-set row, where the eviction pass can see it", async () => {
    const manager = build({ labels, overrideRules: [pinRule] });
    const c = candidate();
    const verdict = await manager.decide(c);
    expect(verdict.pinned).toBe(true);

    await manager.noteArrival(c, verdict);
    expect(manager.index.get(c.objectStorageKey)!.pinned).toBe(true);
    // And it is genuinely rule-derived: the table says nothing about it.
    expect(manager.isPinned("r1")).toBe(false);
  });

  it("does the same through the reservation, which lands first", async () => {
    const manager = build({ labels, overrideRules: [pinRule] });
    const c = candidate();
    manager.reserve(c, await manager.decide(c));
    expect(manager.index.get(c.objectStorageKey)!.pinned).toBe(true);
  });

  // The fallback that has to survive: `fetchBlob` synthesizes a verdict it never
  // asked the policy for, so an absent `pinned` means "nobody resolved this" and
  // the table is the right answer there.
  it("falls back to the table when the verdict resolved no pin", async () => {
    const manager = build();
    manager.setPinned("r1", true);
    const c = candidate();
    await manager.noteArrival(c, {
      decision: "fetch",
      sizeClass: null,
      reason: "explicit-request",
    });
    expect(manager.index.get(c.objectStorageKey)!.pinned).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// r4 #6 — the ordering terms reach the row that the pass sorts on
// ---------------------------------------------------------------------------

/**
 * What N1 became.
 *
 * The finding was that `recencyAtMs` was hard-coded null at all three
 * construction sites, so the policy's recency window excluded nothing, ever.
 * The window is gone — it was predicting what the eviction order does with
 * better evidence — but the date it read is that order's last term, and null
 * still collapses a tier of the sort into a tie. So the wiring is asserted
 * where it now shows: on the row, and on which blob gets displaced.
 */
describe("the dates that place a blob in the eviction order", () => {
  /** A `captured_at` as the column stores it: a SQL timestamp, no zone. */
  function storedTimestamp(msAgo: number): string {
    return new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
  }

  it("records a capture date on the row the pass sorts on", async () => {
    const manager = build({ capturedAt: { r1: storedTimestamp(200 * DAY_MS) } });
    const c = candidate();
    await manager.noteArrival(c, await manager.decide(c));
    const stored = manager.index.get(c.objectStorageKey)!.recencyAtMs!;
    expect(Math.abs(stored - (Date.now() - 200 * DAY_MS))).toBeLessThan(2000);
  });

  /**
   * The rendition half of the same hole, and the more consequential one.
   *
   * A rendition's metadata write is `{ width, height }` — there is no
   * `captured_at` on one — so every derived record ranked null and the
   * ordering's last tier was dead across the whole ladder, which is most of the
   * rows in any library. Reading the parent's date is the fix, and it is read
   * rather than copied because a denormalized date drifts the moment anything
   * backfills or corrects EXIF.
   */
  it("reads a derived record's date from its parent", async () => {
    const manager = build({
      capturedAt: { parent1: storedTimestamp(400 * DAY_MS) },
      records: { parent1: { type: "image/jpeg" } },
      labels: { r1: [{ appId: "photos", key: "rendition", value: "image-thumb" }] },
    });
    const c = candidate({ parentId: "parent1" });
    await manager.noteArrival(c, await manager.decide(c));
    const stored = manager.index.get(c.objectStorageKey)!.recencyAtMs!;
    expect(Math.abs(stored - (Date.now() - 400 * DAY_MS))).toBeLessThan(2000);
  });

  // The direction that must not change. A parent row that cannot be read leaves
  // the blob undated rather than treated as ancient — the alternative is a
  // metadata gap deciding which photographs get deleted.
  it("leaves a derived record undated when its parent cannot be read", async () => {
    const manager = build({
      labels: { r1: [{ appId: "photos", key: "rendition", value: "image-thumb" }] },
    });
    const c = candidate({ parentId: "missing-parent" });
    await manager.noteArrival(c, await manager.decide(c));
    expect(manager.index.get(c.objectStorageKey)!.recencyAtMs).toBeNull();
  });

  // The stored value is a bare SQL timestamp and SQLite's `strftime('%s', ...)`
  // reads it as UTC. `Date.parse` reads a zoneless string as *local*, so the two
  // would disagree by the operator's offset — up to fourteen hours.
  it("reads a zoneless timestamp as UTC", async () => {
    const daysAgo30 = new Date(Date.now() - 30 * DAY_MS);
    const manager = build({
      capturedAt: { r1: daysAgo30.toISOString().replace("T", " ").slice(0, 19) },
    });
    const c = candidate();
    await manager.noteArrival(c, await manager.decide(c));
    const stored = manager.index.get(c.objectStorageKey)!.recencyAtMs!;
    expect(Math.abs(stored - daysAgo30.getTime())).toBeLessThan(1000);
  });

  // Whatever the caller already knew wins: `MobileNode.fetchBlob` passes
  // `lastOpenedAtMs: Date.now()` because opening a photo *is* the event, and it
  // knows that better than any stored row does.
  it("prefers a date the caller supplied over the one it would have looked up", async () => {
    const supplied = Date.now() - 2 * DAY_MS;
    const manager = build({ capturedAt: { r1: storedTimestamp(200 * DAY_MS) } });
    const c = candidate({ recencyAtMs: supplied });
    await manager.noteArrival(c, await manager.decide(c));
    expect(manager.index.get(c.objectStorageKey)!.recencyAtMs).toBe(supplied);
  });

  // An app-syncable row has no shared-record metadata to read, and asking for it
  // by a null type would be a query against a category that does not exist.
  it("treats an app-syncable blob's date as unknown rather than querying for it", async () => {
    const manager = build({ capturedAt: { r1: storedTimestamp(200 * DAY_MS) } });
    const c = candidate({ appId: "notes", type: null });
    await manager.noteArrival(c, await manager.decide(c));
    // The stored capture date for the same id is not borrowed for a row that
    // has nothing to do with it.
    expect(manager.index.get(c.objectStorageKey)!.recencyAtMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Admission by displacement — the acquisition-order half of the ordering
// ---------------------------------------------------------------------------

/**
 * A sync round walks the change log forward, which is oldest first. A budget
 * that simply stopped at full would therefore fill a device with its oldest
 * material and decline everything since — which is the problem the old
 * `recent-only` window was quietly standing in for, expressed as a date cutoff
 * instead of as an order.
 *
 * These go through the manager rather than `decideResidency` because the whole
 * question is whether the resident set answers it, and a stubbed predicate
 * would assert nothing about that.
 */
describe("a full line still admits something that outranks what is held", () => {
  const tiny = policyWith({ platform: onlyClass("original:image", 2000) });

  async function land(manager: ResidencyManager, id: string, openedAtMs: number | null) {
    const c = candidate({ recordId: id, objectStorageKey: `key-${id}`, sizeBytes: 1000 });
    await manager.noteArrival(c, await manager.decide(c));
    if (openedAtMs !== null) manager.markOpened(id, openedAtMs);
  }

  it("admits a blob that beats the worst resident, and declines one that does not", async () => {
    const manager = build({ policy: tiny });
    // Two blobs fill the line. One has been opened; one never has, so it is the
    // first thing the next pass would give up.
    await land(manager, "opened", Date.now());
    await land(manager, "never-opened", null);

    // A newcomer that has been opened outranks the never-opened resident.
    const wanted = await manager.decide(
      candidate({ recordId: "wanted", objectStorageKey: "key-wanted", sizeBytes: 1000, lastOpenedAtMs: Date.now() }),
    );
    expect(wanted).toMatchObject({ decision: "fetch", reason: "displaces-worse" });

    // One that has not is a tie with the worst resident, and a tie is not a
    // reason to spend the transfer: landing it would be a download followed by
    // a delete.
    const unwanted = await manager.decide(
      candidate({ recordId: "unwanted", objectStorageKey: "key-unwanted", sizeBytes: 1000 }),
    );
    expect(unwanted).toMatchObject({ decision: "elide", reason: "budget-exhausted" });
  });

  // A pinned resident is not displaceable, so it cannot make room for anything —
  // `evictionCandidates` excludes it and the admission check reads the same
  // query, which is what keeps the two halves from disagreeing.
  it("does not count pinned bytes as displaceable", async () => {
    const manager = build({ policy: tiny });
    await land(manager, "pinned-one", null);
    await land(manager, "pinned-two", null);
    manager.setPinned("pinned-one", true);
    manager.setPinned("pinned-two", true);

    const verdict = await manager.decide(
      candidate({ recordId: "wanted", objectStorageKey: "key-wanted", sizeBytes: 1000, lastOpenedAtMs: Date.now() }),
    );
    expect(verdict).toMatchObject({ decision: "elide", reason: "budget-exhausted" });
  });
});
