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
 *   - `recencyAtMs` was hard-coded null at every construction site, so
 *     `recent-only` was `keep: "all"` with a different reason string (N1).
 *
 * All three are invisible from either side of the seam alone.
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

const keepAll: SizeClassRetention = { keep: "all", budgetBytes: 100 * MB };

function policyWith(over: Partial<NodeRetentionPolicy> = {}): NodeRetentionPolicy {
  return {
    platform: { rows: { "original:image": keepAll }, fallback: keepAll },
    apps: {},
    appFallback: { rows: {}, fallback: keepAll, totalBudgetBytes: 100 * MB },
    ...over,
  };
}

/**
 * Labels and capture times keyed by record id.
 *
 * `getMetadataByIds` answers for real here, unlike the classification suite next
 * door: the recency axis is the point of half these cases, and a stub returning
 * an empty map is exactly the state N1 describes — the decider reading null and
 * fetching everything.
 */
function adapter(
  labels: Record<string, Label[]> = {},
  capturedAt: Record<string, string> = {},
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
  } as unknown as DatabaseAdapter;
}

interface BuildOptions {
  readonly labels?: Record<string, Label[]>;
  readonly capturedAt?: Record<string, string>;
  readonly policy?: NodeRetentionPolicy;
  readonly overrideRules?: readonly OverrideRule[];
  readonly isCloudNode?: boolean;
}

function build(options: BuildOptions = {}): ResidencyManager {
  return createResidencyManager({
    localDb: new DatabaseSync(":memory:") as never,
    databaseAdapter: adapter(options.labels, options.capturedAt),
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
  const tight = policyWith({
    platform: {
      rows: { "original:image": { keep: "all", budgetBytes: 500 } },
      fallback: keepAll,
    },
  });

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
  const smallClass = policyWith({
    platform: {
      rows: { "original:image": { keep: "all", budgetBytes: 2500 } },
      fallback: keepAll,
    },
  });

  function landed(manager: ResidencyManager, id: string, sizeBytes: number) {
    const c = candidate({ recordId: id, objectStorageKey: `key-${id}`, sizeBytes });
    return manager.noteArrival(c, {
      decision: "fetch",
      sizeClass: { namespace: "starkeep", rung: "original:image", qualified: "starkeep:original:image" },
      pinned: false,
      reason: "keep-all",
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

  // The namespace total is a second, independent gate, and it is what makes an
  // invented rung cheap rather than free — the per-rung fallback would otherwise
  // hand out one budget per name.
  it("declines on the namespace total even when the rung's own row has room", async () => {
    const manager = build({
      policy: policyWith({
        apps: {
          photos: {
            rows: {},
            fallback: { keep: "all", budgetBytes: 100 * MB },
            totalBudgetBytes: 2500,
          },
        },
      }),
      labels: {
        a: [{ appId: "photos", key: "rendition", value: "one" }],
        b: [{ appId: "photos", key: "rendition", value: "two" }],
        c: [{ appId: "photos", key: "rendition", value: "three" }],
      },
    });

    for (const id of ["a", "b"]) {
      const c = candidate({ recordId: id, objectStorageKey: `key-${id}`, sizeBytes: 1000, parentId: "p" });
      await manager.noteArrival(c, await manager.decide(c));
    }

    const verdict = await manager.decide(
      candidate({ recordId: "c", sizeBytes: 1000, parentId: "p" }),
    );
    // Each rung's own row had 100 MB free. Reported distinctly because the
    // remedy is a different number: raising the row does nothing.
    expect(verdict.reason).toBe("namespace-budget-exhausted");
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
      policy: policyWith({
        platform: {
          rows: { "original:image": { keep: "all", budgetBytes: 500 } },
          fallback: keepAll,
        },
      }),
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
// r4 #6 — N1: the recency dimension can actually bind
// ---------------------------------------------------------------------------

describe("recencyAtMs reaches the decider", () => {
  const recentOnly = policyWith({
    platform: {
      rows: {
        "original:image": { keep: "recent-only", recencyWindowDays: 30, budgetBytes: 100 * MB },
      },
      fallback: keepAll,
    },
  });

  /** A `captured_at` as the column stores it: a SQL timestamp, no zone. */
  function storedTimestamp(msAgo: number): string {
    return new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
  }

  /**
   * The finding, stated as a test: before the manager read capture times,
   * `recent-only` was `keep: "all"` capped by the budget. Every candidate had
   * `recencyAtMs: null` at all three construction sites, null means "unknown",
   * and unknown deliberately fetches — so the window excluded nothing, ever,
   * while the census read a real capture date and promised an operator a number
   * the engine could not produce.
   */
  it("declines a record outside the window", async () => {
    const manager = build({
      policy: recentOnly,
      capturedAt: { r1: storedTimestamp(200 * DAY_MS) },
    });
    const verdict = await manager.decide(candidate());
    expect(verdict.decision).toBe("elide");
    expect(verdict.reason).toBe("outside-recency-window");
  });

  it("keeps a record inside it", async () => {
    const manager = build({
      policy: recentOnly,
      capturedAt: { r1: storedTimestamp(5 * DAY_MS) },
    });
    expect((await manager.decide(candidate())).reason).toBe("within-recency-window");
  });

  // An unknown date is not evidence of age. This is the direction that must not
  // change: a metadata gap costing the bytes would make "the deriver has not run
  // yet" indistinguishable from "this is ancient".
  it("fetches when no capture date has been derived yet", async () => {
    const manager = build({ policy: recentOnly });
    expect((await manager.decide(candidate())).decision).toBe("fetch");
  });

  // The stored value is a bare SQL timestamp and the census reads it with
  // `strftime('%s', ...)`, which is UTC. `Date.parse` reads a zoneless string as
  // *local*, so the two would disagree by the operator's offset — up to fourteen
  // hours, enough to move a record across the edge of a window.
  it("reads a zoneless timestamp as UTC, the way the census does", async () => {
    const daysAgo30 = new Date(Date.now() - 30 * DAY_MS);
    const manager = build({
      policy: policyWith({
        platform: {
          rows: {
            "original:image": {
              keep: "recent-only",
              recencyWindowDays: 3650,
              budgetBytes: 100 * MB,
            },
          },
          fallback: keepAll,
        },
      }),
      capturedAt: { r1: daysAgo30.toISOString().replace("T", " ").slice(0, 19) },
    });
    const c = candidate();
    await manager.noteArrival(c, await manager.decide(c));
    const stored = manager.index.get(c.objectStorageKey)!.recencyAtMs!;
    // Within a second of the UTC reading, rather than an offset away from it.
    expect(Math.abs(stored - daysAgo30.getTime())).toBeLessThan(1000);
  });

  // `openedWithinDays` is the second half of the axis: a library you actually
  // browse has a working set that is not the same shape as its calendar. It
  // reads the index's own `last_opened_at_ms`, which is the row this manager
  // maintains.
  it("keeps an old record that was opened recently", async () => {
    const manager = build({
      policy: policyWith({
        platform: {
          rows: {
            "original:image": {
              keep: "recent-only",
              recencyWindowDays: 30,
              openedWithinDays: 7,
              budgetBytes: 100 * MB,
            },
          },
          fallback: keepAll,
        },
      }),
      capturedAt: { r1: storedTimestamp(200 * DAY_MS) },
    });

    const c = candidate();
    expect((await manager.decide(c)).decision).toBe("elide");

    await manager.noteArrival(c, {
      decision: "fetch",
      sizeClass: null,
      pinned: false,
      reason: "explicit-request",
    });
    manager.markOpened("r1", Date.now());

    expect((await manager.decide(c)).decision).toBe("fetch");
  });

  // Whatever the caller already knew wins: `MobileNode.fetchBlob` passes
  // `lastOpenedAtMs: Date.now()` because opening a photo *is* the event, and it
  // knows that better than any stored row does.
  it("prefers a date the caller supplied over the one it would have looked up", async () => {
    const manager = build({
      policy: recentOnly,
      capturedAt: { r1: storedTimestamp(200 * DAY_MS) },
    });
    const verdict = await manager.decide(
      candidate({ recencyAtMs: Date.now() - 2 * DAY_MS }),
    );
    expect(verdict.decision).toBe("fetch");
  });

  // An app-syncable row has no shared-record metadata to read, and asking for it
  // by a null type would be a query against a category that does not exist.
  it("treats an app-syncable blob's recency as unknown rather than querying for it", async () => {
    const manager = build({
      policy: policyWith({
        apps: {},
        appFallback: {
          rows: {},
          fallback: {
            keep: "recent-only",
            recencyWindowDays: 30,
            budgetBytes: 100 * MB,
          },
          totalBudgetBytes: 100 * MB,
        },
      }),
      capturedAt: { r1: storedTimestamp(200 * DAY_MS) },
    });
    // Unknown fetches, and the stored capture date for the same id is not
    // borrowed for a row that has nothing to do with it.
    expect((await manager.decide(candidate({ appId: "notes", type: null }))).decision).toBe(
      "fetch",
    );
  });
});
