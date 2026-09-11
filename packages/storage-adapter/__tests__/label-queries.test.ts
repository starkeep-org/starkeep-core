/**
 * The label SQL both backends share — the write path, the forward lookup and
 * the sync-side scan.
 *
 * These tests compile against *both* dialects from one call site, which is the
 * point: the label queries used to be written twice, and the copies could drift
 * without any test noticing. Here a change that only lands in one dialect shows
 * up as a diff between the two compiled statements.
 *
 * The **reverse** query is a parsed query now and is pinned next door in
 * `label-find.test.ts`, against the same two dialects.
 *
 * DSQL's real behaviour cannot be exercised offline, so this is also where the
 * Postgres-only spellings — schema-qualified table names among them — are
 * pinned; the AWS e2e journey is the only place they run for real.
 */
import { describe, it, expect } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { createHLCClock, type StarkeepId } from "@starkeep/protocol-primitives";
import {
  buildGetLabel,
  buildLabelNodeWatermarks,
  buildLabelRetraction,
  buildLabelSnapshotUpsert,
  buildLabelUpsert,
  buildLabelsByRecordIds,
  buildQueryLabels,
  buildTombstoneLabelsForRecord,
  encodeLabelScanCursor,
  type LabelDb,
  type LabelDialect,
} from "../src/index.js";

const sqlite = new Kysely<LabelDb>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

const postgres = new Kysely<LabelDb>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const SQLITE: LabelDialect = { table: "shared_record_labels" };
const DSQL: LabelDialect = { table: "shared.record_labels" };

const clock = createHLCClock({ nodeId: "nodeA", wallClockFunction: () => 1000 });
const rid = (s: string) => s as StarkeepId;

/** Compile one builder against both backends. */
function both<T>(fn: (k: Kysely<LabelDb>, d: LabelDialect) => T): { sqlite: T; dsql: T } {
  return { sqlite: fn(sqlite, SQLITE), dsql: fn(postgres, DSQL) };
}

const upsertRow = {
  recordId: rid("rec1"),
  appId: "alpha",
  key: "quality",
  value: "high",
  recordType: "image/jpeg",
  hlc: clock.now(),
};

describe("buildLabelUpsert", () => {
  it("emits one multi-row statement, not a statement per row", () => {
    // A loop of single writes would cost a round trip each and blow DSQL's
    // 3,000-modified-rows budget differently.
    const { sqlite: s, dsql: d } = both((k, dialect) =>
      buildLabelUpsert(k, dialect, [
        upsertRow,
        { ...upsertRow, recordId: rid("rec2") },
        { ...upsertRow, recordId: rid("rec3") },
      ]),
    );
    for (const q of [s, d]) {
      expect(q.sql.match(/insert into/g)).toHaveLength(1);
      // Three value tuples in one statement.
      expect(q.sql.match(/\(\$?\d*[?,\s$\d]*\)/g)!.length).toBeGreaterThanOrEqual(3);
      expect(q.parameters).toContain("rec2");
      expect(q.parameters).toContain("rec3");
    }
  });

  it("clears deleted_at on conflict, so re-setting a retracted label revives it", () => {
    // Without this a set → retract → set cycle writes a row that stays
    // invisible forever.
    const { sqlite: s, dsql: d } = both((k, dialect) =>
      buildLabelUpsert(k, dialect, [upsertRow]),
    );
    for (const q of [s, d]) {
      const updateSet = q.sql.slice(q.sql.indexOf("do update set"));
      expect(q.sql).toMatch(
        /on conflict \("record_id", "app_id", "key", "value"\) do update set/,
      );
      // `value` is a conflict *target*, not something to overwrite: a differing
      // value is a different row, so there is nothing left for it to update.
      expect(updateSet).not.toMatch(/"value" =/);
      // Bound as a parameter rather than a literal `null`, so this checks the
      // column is in the update set and that the value bound for it is null.
      expect(updateSet).toMatch(/"deleted_at" = /);
      expect(q.parameters[q.parameters.length - 1]).toBeNull();
      // created_at is deliberately NOT in the update set: an upsert over an
      // existing row must not restamp when the label was first asserted.
      expect(updateSet).not.toMatch(/"created_at" =/);
    }
  });

  it("de-dupes a repeated primary key, keeping the last — the 21000 guard", () => {
    // Postgres rejects a multi-row ON CONFLICT DO UPDATE that touches one row
    // twice; SQLite keeps the last. Deduping here is what stops that becoming
    // a cloud-only failure.
    const { dsql } = both((k, dialect) =>
      buildLabelUpsert(k, dialect, [
        upsertRow, // rec1/quality = "high"
        { ...upsertRow, recordType: "image/png" }, // the same row again, later
        { ...upsertRow, recordId: rid("rec2"), value: "other", recordType: "image/gif" },
      ]),
    );
    // The superseded row never reaches the statement, and rec1 appears once.
    expect(dsql.parameters.filter((p) => p === "image/jpeg")).toHaveLength(0);
    expect(dsql.parameters.filter((p) => p === "image/png")).toHaveLength(1);
    expect(dsql.parameters.filter((p) => p === "rec1")).toHaveLength(1);
    // The distinct row is untouched by the dedupe.
    expect(dsql.parameters.filter((p) => p === "other")).toHaveLength(1);
  });

  it("keeps two values of one key as two rows — the set-valued case", () => {
    // The dedupe key includes `value`; on the three-column tuple this batch
    // would collapse to one row and turn a set-valued write into a
    // single-valued one, with no error and perfectly plausible output.
    const { dsql } = both((k, dialect) =>
      buildLabelUpsert(k, dialect, [
        { ...upsertRow, key: "face", value: "Alice" },
        { ...upsertRow, key: "face", value: "Bob" },
      ]),
    );
    expect(dsql.parameters.filter((p) => p === "Alice")).toHaveLength(1);
    expect(dsql.parameters.filter((p) => p === "Bob")).toHaveLength(1);
  });

  it("addresses the right table on each backend", () => {
    const { sqlite: s, dsql: d } = both((k, dialect) =>
      buildLabelUpsert(k, dialect, [upsertRow]),
    );
    expect(s.sql).toContain('"shared_record_labels"');
    expect(d.sql).toContain('"shared"."record_labels"');
  });
});

describe("buildLabelSnapshotUpsert", () => {
  const snapshot = {
    recordId: rid("rec1"),
    appId: "alpha",
    key: "k",
    value: "",
    recordType: "image/jpeg",
    createdAt: clock.now(),
    updatedAt: clock.now(),
    nodeId: "nodeA",
    deletedAt: clock.now(),
  };

  it("writes every column from the incoming row, tombstone included", () => {
    // The sync apply path's put: an inbound retraction must stay retracted,
    // which is exactly what buildLabelUpsert's `deleted_at = null` would undo.
    const { sqlite: s, dsql: d } = both((k, dialect) =>
      buildLabelSnapshotUpsert(k, dialect, snapshot),
    );
    for (const q of [s, d]) {
      expect(q.sql).toMatch(/"deleted_at" = "excluded"\."deleted_at"/);
      expect(q.sql).toMatch(/"created_at" = "excluded"\."created_at"/);
      expect(q.sql).not.toMatch(/"deleted_at" = null/);
    }
  });
});

describe("buildLabelRetraction and the delete cascade", () => {
  it("tombstones by primary key — never a DELETE", () => {
    const { sqlite: s, dsql: d } = both((k, dialect) =>
      buildLabelRetraction(k, dialect, {
        recordId: rid("rec1"),
        appId: "alpha",
        key: "k",
        value: "v",
        hlc: clock.now(),
      }),
    );
    for (const q of [s, d]) {
      expect(q.sql).toMatch(/^update /);
      expect(q.sql).toMatch(/set "deleted_at"/);
      expect(q.sql).toMatch(/"record_id" = /);
      // app_id in the predicate is the whole of "an app can only retract its
      // own labels".
      expect(q.sql).toMatch(/"app_id" = /);
      expect(q.sql).toMatch(/"key" = /);
      expect(q.sql).toMatch(/"value" = /);
    }
  });

  it("omitting the value retracts every value of the key", () => {
    // The one shape that quietly does nothing if it pins `value` anyway: an app
    // with three names on a photo asking to take the key back.
    const { dsql } = both((k, dialect) =>
      buildLabelRetraction(k, dialect, {
        recordId: rid("rec1"),
        appId: "alpha",
        key: "face",
        hlc: clock.now(),
      }),
    );
    expect(dsql.sql).toMatch(/"key" = /);
    expect(dsql.sql).not.toMatch(/"value" = /);
  });

  it("the record cascade crosses namespaces and skips existing tombstones", () => {
    const { sqlite: s, dsql: d } = both((k, dialect) =>
      buildTombstoneLabelsForRecord(k, dialect, rid("rec1"), clock.now()),
    );
    for (const q of [s, d]) {
      // No app_id predicate: the record is going away, so every app's
      // assertions about it go with it.
      expect(q.sql).not.toMatch(/"app_id" = /);
      // Already-tombstoned rows are left alone rather than restamped.
      expect(q.sql).toMatch(/"deleted_at" is null/);
    }
  });
});

describe("the sync-facing queries", () => {
  it("queryLabels orders by primary key and does NOT exclude tombstones", () => {
    // The opposite of the reverse query: a retraction has to ship, so the scan
    // that feeds sync must see it.
    const { sqlite: s, dsql: d } = both((k, dialect) => buildQueryLabels(k, dialect, {}));
    for (const q of [s, d]) {
      expect(q.sql).toMatch(
        /order by "record_id" asc, "app_id" asc, "key" asc, "value" asc/,
      );
      expect(q.sql).not.toMatch(/"deleted_at" is null/);
    }
  });

  it("queryLabels expands its cursor over all four primary-key columns", () => {
    const q = buildQueryLabels(postgres, DSQL, {
      cursor: encodeLabelScanCursor({
        recordId: rid("rec1"),
        appId: "alpha",
        key: "k",
        value: "v",
      }),
    });
    expect(q.sql).toMatch(/"record_id" > /);
    expect(q.sql).toMatch(/"record_id" = .* and "app_id" > /);
    expect(q.sql).toMatch(/"app_id" = .* and "key" > /);
    // The value leg. Without it the cursor is not unique, so every sibling
    // value of a key after the first is skipped — sync loses label rows with
    // nothing to notice, a short page not being an error.
    expect(q.sql).toMatch(/"key" = .* and "value" > /);
  });

  it("getLabel reads by primary key including tombstones — the LWW compare", () => {
    const { dsql } = both((k, dialect) =>
      buildGetLabel(k, dialect, rid("rec1"), "alpha", "k", "v"),
    );
    expect(dsql.sql).not.toMatch(/"deleted_at" is null/);
    // `value` included: each value of a set-valued key has its own LWW domain,
    // and looking up without it compares an incoming row against whichever
    // sibling was found first.
    expect(dsql.parameters).toEqual(["rec1", "alpha", "k", "v"]);
  });

  it("the watermark query folds max(updated_at) per node over every row", () => {
    const { sqlite: s, dsql: d } = both((k, dialect) =>
      buildLabelNodeWatermarks(k, dialect),
    );
    for (const q of [s, d]) {
      expect(q.sql).toMatch(/max\("updated_at"\)/);
      expect(q.sql).toMatch(/group by "node_id"/);
      // Tombstones count: the responder's coverage watermark is a union over
      // both tables, and a retraction is the latest thing a node may have done.
      expect(q.sql).not.toMatch(/"deleted_at" is null/);
    }
  });

  it("the forward hydration query is a primary-key IN-list over live rows only", () => {
    const { dsql } = both((k, dialect) =>
      buildLabelsByRecordIds(k, dialect, [rid("rec1"), rid("rec2")]),
    );
    expect(dsql.sql).toMatch(/"record_id" in/);
    expect(dsql.sql).toMatch(/"deleted_at" is null/);
    expect(dsql.parameters).toEqual(["rec1", "rec2"]);
  });
});
