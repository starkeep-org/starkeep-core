/**
 * The size-class census that feeds the retention matrix.
 *
 * Against a real SQLite database, because every risk here is in the SQL: a
 * join that drops rows, a date column read as the wrong kind of thing, a
 * cumulative bucket that is off by one at the boundary the operator is looking
 * at. None of those are visible in a mocked query.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { buildCensus, ageInDays, CENSUS_CUTOFF_DAYS } from "../census.js";

const MB = 1024 * 1024;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 1);

let db: DatabaseSync;

const CLASS_LABEL = { appId: "photos", key: "rendition" };
const options = {
  sizeClassKeys: { [CLASS_LABEL.appId]: CLASS_LABEL.key },
  originalClassFor: (type: string | null) => ({
    qualified: `starkeep:original:${type ?? "unknown"}`,
  }),
  nowMs: NOW,
};

/** Classes are stored fully qualified, so the tests name them that way. */
const photos = (rung: string) => `photos:${rung}`;
const original = (type: string) => `starkeep:original:${type}`;

/** Only the columns the census reads — enough to exercise the real joins. */
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE shared_records (
      id TEXT PRIMARY KEY, type TEXT, size_bytes INTEGER,
      created_at TEXT, deleted_at TEXT, parent_id TEXT, origin_app_id TEXT
    );
    CREATE TABLE shared_record_labels (
      record_id TEXT, app_id TEXT, key TEXT, value TEXT, deleted_at TEXT
    );
    CREATE TABLE shared_record_image_metadata (record_id TEXT PRIMARY KEY, captured_at TEXT);
    CREATE TABLE shared_record_video_metadata (record_id TEXT PRIMARY KEY, captured_at TEXT);
  `);
});

function addRecord(
  id: string,
  opts: {
    type?: string;
    sizeBytes?: number;
    sizeClass?: string;
    capturedDaysAgo?: number;
    deleted?: boolean;
    /**
     * Whether this record is derived. Defaults to true whenever a `sizeClass`
     * is given, because that is the only shape a rung can legitimately appear
     * on: the platform/app split is decided by `parent_id`, so a labelled
     * record with no parent is still an original.
     */
    parentId?: string | null;
    originAppId?: string | null;
  } = {},
): void {
  const parentId =
    opts.parentId !== undefined ? opts.parentId : opts.sizeClass ? `${id}-parent` : null;
  db.prepare("INSERT INTO shared_records VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    opts.type ?? "image/jpeg",
    opts.sizeBytes ?? MB,
    // A serialized HLC, deliberately — the census must not read this as a date.
    "01J3XZ8Q4K0000-0001-node-a",
    opts.deleted ? "2026-01-01" : null,
    parentId,
    opts.originAppId !== undefined ? opts.originAppId : "photos",
  );
  if (opts.sizeClass) {
    db.prepare("INSERT INTO shared_record_labels VALUES (?, ?, ?, ?, ?)").run(
      id, CLASS_LABEL.appId, CLASS_LABEL.key, opts.sizeClass, null,
    );
  }
  if (opts.capturedDaysAgo !== undefined) {
    db.prepare("INSERT INTO shared_record_image_metadata VALUES (?, ?)").run(
      id,
      new Date(NOW - opts.capturedDaysAgo * DAY).toISOString().replace("T", " ").slice(0, 19),
    );
  }
}

const classOf = (rows: ReturnType<typeof buildCensus>, name: string) =>
  rows.find((r) => r.sizeClass === name);

describe("grouping by size class", () => {
  it("groups records by the label the host names", () => {
    addRecord("a", { sizeClass: "image-medium", sizeBytes: 2 * MB });
    addRecord("b", { sizeClass: "image-medium", sizeBytes: 3 * MB });
    addRecord("c", { sizeClass: "image-thumb", sizeBytes: 100 });

    const census = buildCensus(db, options);
    expect(classOf(census, photos("image-medium"))).toMatchObject({
      recordCount: 2,
      totalBytes: 5 * MB,
    });
    expect(classOf(census, photos("image-thumb"))!.recordCount).toBe(1);
  });

  // The single largest class in any library. An inner join would silently drop
  // exactly the rows the retention matrix exists to budget for.
  it("counts unlabelled records as originals rather than dropping them", () => {
    addRecord("orig", { type: "image/jpeg", sizeBytes: 40 * MB });
    const census = buildCensus(db, options);
    expect(classOf(census, original("image/jpeg"))).toMatchObject({
      recordCount: 1,
      totalBytes: 40 * MB,
    });
  });

  it("ignores a label from a different app or key", () => {
    addRecord("a", { sizeBytes: MB });
    db.prepare("INSERT INTO shared_record_labels VALUES (?, ?, ?, ?, ?)").run(
      "a", "someotherapp", "rendition", "image-medium", null,
    );
    // Still an original: another app's label of the same name says nothing
    // about Photos' ladder.
    expect(classOf(buildCensus(db, options), original("image/jpeg"))!.recordCount).toBe(1);
  });

  it("ignores a tombstoned class label", () => {
    addRecord("a", { sizeBytes: MB });
    db.prepare("INSERT INTO shared_record_labels VALUES (?, ?, ?, ?, ?)").run(
      "a", CLASS_LABEL.appId, CLASS_LABEL.key, "image-medium", "2026-01-01",
    );
    expect(classOf(buildCensus(db, options), photos("image-medium"))).toBeUndefined();
  });

  it("excludes deleted records", () => {
    addRecord("gone", { sizeClass: "image-medium", deleted: true });
    expect(buildCensus(db, options)).toEqual([]);
  });

  // The gap that made this necessary: with one configured app, a second
  // rendition-producing app matched nothing and its cheap derivatives were
  // counted as originals — the largest and most protected class there is.
  it("reads a second app's ladder into its own namespace", () => {
    addRecord("p", { sizeClass: "image-medium", sizeBytes: 2 * MB });
    db.prepare("INSERT INTO shared_records VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "s", "image/jpeg", 3 * MB, "01J3XZ8Q4K0000-0001-node-a", null, "s-parent", "sketcher",
    );
    db.prepare("INSERT INTO shared_record_labels VALUES (?, ?, ?, ?, ?)").run(
      "s", "sketcher", "derived-size", "preview", null,
    );

    const census = buildCensus(db, {
      ...options,
      sizeClassKeys: { photos: "rendition", sketcher: "derived-size" },
    });
    expect(classOf(census, "sketcher:preview")).toMatchObject({ totalBytes: 3 * MB });
    expect(classOf(census, photos("image-medium"))).toMatchObject({ totalBytes: 2 * MB });
  });

  // The platform/app split is decided by `parent_id`, so a rendition label on a
  // parentless record does not move it out of the originals.
  it("counts a labelled record with no parent as an original anyway", () => {
    addRecord("a", { sizeClass: "image-medium", sizeBytes: MB, parentId: null });
    const census = buildCensus(db, options);
    expect(classOf(census, photos("image-medium"))).toBeUndefined();
    expect(classOf(census, original("image/jpeg"))!.recordCount).toBe(1);
  });

  // Derived but unlabelled: charged to whoever created the record rather than
  // promoted into the protected tier by the absence of a label.
  it("charges an unlabelled derivative to its origin app", () => {
    db.prepare("INSERT INTO shared_records VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "d", "image/jpeg", MB, "01J3XZ8Q4K0000-0001-node-a", null, "d-parent", "sketcher",
    );
    const census = buildCensus(db, options);
    expect(classOf(census, "sketcher:unclassified")!.recordCount).toBe(1);
  });

  it("puts the biggest class first, which is what the matrix leads with", () => {
    addRecord("small", { sizeClass: "image-thumb", sizeBytes: 100 });
    addRecord("big", { sizeClass: "image-large", sizeBytes: 50 * MB });
    expect(buildCensus(db, options)[0]!.sizeClass).toBe(photos("image-large"));
  });
});

describe("recency", () => {
  it("accumulates cumulatively, so a cutoff is a prefix not a bucket", () => {
    addRecord("recent", { sizeClass: "c", sizeBytes: MB, capturedDaysAgo: 5 });
    addRecord("older", { sizeClass: "c", sizeBytes: 2 * MB, capturedDaysAgo: 60 });
    addRecord("ancient", { sizeClass: "c", sizeBytes: 4 * MB, capturedDaysAgo: 500 });

    const c = classOf(buildCensus(db, options), photos("c"))!;
    expect(c.bytesWithinDays[7]).toBe(MB);
    expect(c.bytesWithinDays[90]).toBe(3 * MB);
    expect(c.bytesWithinDays[730]).toBe(7 * MB);
  });

  // `created_at` holds a serialized HLC. Read as a date it yields a number that
  // is meaningless *and plausible*, which is the worst kind of wrong — every
  // record would land in some arbitrary bucket and the matrix would look fine.
  it("never mistakes the HLC in created_at for a capture date", () => {
    addRecord("nodate", { sizeClass: "c", sizeBytes: MB });
    const c = classOf(buildCensus(db, options), photos("c"))!;
    // Unknown date counts toward every cutoff, including the shortest — the
    // same rule residency follows, because an unknown date is not evidence of
    // age and missing metadata must not become deleted bytes.
    for (const cutoff of CENSUS_CUTOFF_DAYS) {
      expect(c.bytesWithinDays[cutoff], `cutoff ${cutoff}`).toBe(MB);
    }
  });

  it("reads a video's capture time as well as an image's", () => {
    addRecord("v", { type: "video/mp4", sizeClass: "video-720p", sizeBytes: 10 * MB });
    db.prepare("INSERT INTO shared_record_video_metadata VALUES (?, ?)").run(
      "v",
      new Date(NOW - 3 * DAY).toISOString().replace("T", " ").slice(0, 19),
    );
    const c = classOf(buildCensus(db, options), photos("video-720p"))!;
    expect(c.bytesWithinDays[7]).toBe(10 * MB);
    expect(c.bytesWithinDays[365]).toBe(10 * MB);
  });

  it("counts a record exactly at a cutoff as inside it", () => {
    addRecord("edge", { sizeClass: "c", sizeBytes: MB, capturedDaysAgo: 30 });
    const c = classOf(buildCensus(db, options), photos("c"))!;
    expect(c.bytesWithinDays[30]).toBe(MB);
  });
});

describe("node-local state", () => {
  function addResidentTable(): void {
    db.exec(`
      CREATE TABLE resident_blobs (
        object_storage_key TEXT PRIMARY KEY, size_class TEXT, size_bytes INTEGER,
        pinned INTEGER, last_opened_at_ms INTEGER
      );
    `);
  }

  it("reports pinned bytes from the resident set", () => {
    addRecord("a", { sizeClass: "image-large", sizeBytes: 5 * MB });
    addResidentTable();
    db.prepare("INSERT INTO resident_blobs VALUES (?, ?, ?, ?, ?)").run(
      "k1", photos("image-large"), 5 * MB, 1, null,
    );
    expect(classOf(buildCensus(db, options), photos("image-large"))!.pinnedBytes).toBe(5 * MB);
  });

  it("reports the recently-opened working set", () => {
    addRecord("a", { sizeClass: "image-large", sizeBytes: 5 * MB });
    addResidentTable();
    db.prepare("INSERT INTO resident_blobs VALUES (?, ?, ?, ?, ?)").run(
      "k1", photos("image-large"), 5 * MB, 0, Date.now() - 2 * DAY,
    );
    const c = classOf(buildCensus(db, options), photos("image-large"))!;
    expect(c.bytesOpenedWithinDays![7]).toBe(5 * MB);
  });

  // The sync engine creates this table lazily. Failing the whole matrix because
  // a node has never synced would be a worse answer than one without pins.
  it("survives a node that has never synced and has no resident set", () => {
    addRecord("a", { sizeClass: "image-large", sizeBytes: 5 * MB });
    const census = buildCensus(db, options);
    expect(classOf(census, photos("image-large"))!.pinnedBytes).toBe(0);
  });
});

describe("age", () => {
  it("is null for an unknown date rather than a large number", () => {
    // A large number would place the record outside every recency window, which
    // marks it for eviction — turning missing metadata into deleted bytes.
    expect(ageInDays(null, NOW)).toBeNull();
    expect(ageInDays(NaN, NOW)).toBeNull();
  });

  it("never reports a negative age for a future date", () => {
    expect(ageInDays(NOW + DAY, NOW)).toBe(0);
  });
});
