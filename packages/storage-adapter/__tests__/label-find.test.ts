/**
 * The reverse label query, now that it is a parsed query.
 *
 * `findByLabel` used to compile its own SQL, and the properties pinned here
 * were pinned against that builder. They are the same properties — tombstones
 * excluded, the index's own ordering, `limit + 1`, presence against exact
 * match, the grant as an index condition — asserted against the path that
 * replaced it, so the migration kept its coverage rather than losing it.
 *
 * Compiled against *both* dialects from one call site, which is what a change
 * landing in only one of them shows up as.
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
import type { StarkeepId } from "@starkeep/protocol-primitives";
import {
  buildAppRowQuery,
  encodePageToken,
  planFindByLabel,
  QueryParseError,
  sharedQueryExcludesSoftDeleted,
  sharedQueryTableName,
  LABEL_QUERY_TARGET,
  type AppQueryDb,
  type FindByLabelQuery,
} from "../src/index.js";

const sqlite = new Kysely<AppQueryDb>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

const postgres = new Kysely<AppQueryDb>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const rid = (s: string) => s as StarkeepId;

/** Compile one reverse query the way an adapter's `queryShared` does. */
function compiled(k: Kysely<AppQueryDb>, dialect: "pg" | "sqlite", query: FindByLabelQuery) {
  const plan = planFindByLabel(query)!;
  return buildAppRowQuery(k, sharedQueryTableName(LABEL_QUERY_TARGET, dialect), plan.query, {
    serverWhere: plan.serverWhere,
    excludeSoftDeleted: sharedQueryExcludesSoftDeleted(LABEL_QUERY_TARGET),
  });
}

function both(query: FindByLabelQuery) {
  return {
    sqlite: compiled(sqlite, "sqlite", query),
    dsql: compiled(postgres, "pg", query),
  };
}

describe("planFindByLabel", () => {
  it("pins app_id and key, which is what makes the reverse index a seek", () => {
    const { sqlite: s, dsql: d } = both({ appId: "alpha", key: "k" });
    for (const q of [s, d]) {
      expect(q.sql).toMatch(/"app_id" = /);
      expect(q.sql).toMatch(/"key" = /);
      expect(q.parameters).toContain("alpha");
      expect(q.parameters).toContain("k");
    }
  });

  it("always pins deleted_at, which is what keeps tombstones out of the range", () => {
    const { sqlite: s, dsql: d } = both({ appId: "alpha", key: "k" });
    for (const q of [s, d]) expect(q.sql).toMatch(/"deleted_at" is null/);
  });

  it("names the table each engine spells it", () => {
    const { sqlite: s, dsql: d } = both({ appId: "alpha", key: "k" });
    expect(s.sql).toMatch(/"shared_record_labels"/);
    expect(d.sql).toMatch(/"shared"\."record_labels"/);
  });

  it("orders on the index's residual key, identically on both backends", () => {
    // `(value, record_id)` with `app_id` and `key` pinned: the reverse index's
    // own order, and the schema's declared primary key for exactly that reason.
    // The leading `(expr is null)` term is the compiler's null position, which
    // it emits rather than `NULLS LAST` because SQLite only learned that
    // syntax in 3.30.
    const { sqlite: s, dsql: d } = both({ appId: "alpha", key: "k" });
    for (const q of [s, d]) {
      expect(q.sql).toMatch(
        /order by \("value" is null\) asc, "value" asc, \("record_id" is null\) asc, "record_id" asc/,
      );
      expect(q.sql).not.toMatch(/nulls/i);
    }
  });

  it("fetches limit + 1 so a full page is distinguishable from the last one", () => {
    expect(both({ appId: "alpha", key: "k", limit: 50 }).dsql.parameters).toContain(51);
  });

  it("defaults to 50 when the caller names no limit", () => {
    expect(both({ appId: "alpha", key: "k" }).dsql.parameters).toContain(51);
  });

  it("omitting value is a presence filter; supplying it is an exact match", () => {
    const presence = compiled(postgres, "pg", { appId: "alpha", key: "k" });
    expect(presence.sql).not.toMatch(/"value" = /);

    const exact = compiled(postgres, "pg", { appId: "alpha", key: "k", value: "high" });
    expect(exact.sql).toMatch(/"value" = /);
    expect(exact.parameters).toContain("high");
  });

  it('value: "" is a real filter — bare flags — and not "no filter"', () => {
    // Degrading a flag query into an unfiltered presence query returns a
    // superset, which is the shape of wrong answer that looks like it works.
    const flags = compiled(postgres, "pg", { appId: "alpha", key: "k", value: "" });
    expect(flags.sql).toMatch(/"value" = /);
    expect(flags.parameters).toContain("");
  });

  it("returns null — no query at all — for a caller with no readable types", () => {
    expect(planFindByLabel({ appId: "alpha", key: "k", readableTypes: new Set() })).toBeNull();
  });

  it("applies the readable-type set as the server's own predicate", () => {
    const plan = planFindByLabel({
      appId: "alpha",
      key: "k",
      readableTypes: new Set(["image/png", "image/jpeg"]),
    })!;
    // The grant is `serverWhere` rather than one of the caller's clauses, which
    // is the separation that keeps it un-overridable — and it is sorted, so the
    // emitted SQL is stable across two calls holding the same grant.
    expect(plan.serverWhere).toEqual([
      { column: "record_type", predicate: { op: "in", values: ["image/jpeg", "image/png"] } },
    ]);
    expect(plan.query.where.some((c) => c.column === "record_type")).toBe(false);
    const q = compiled(postgres, "pg", {
      appId: "alpha",
      key: "k",
      readableTypes: new Set(["image/jpeg", "image/png"]),
    });
    expect(q.sql).toMatch(/"record_type" in/);
    expect(q.parameters).toContain("image/jpeg");
  });

  it("omits the grant entirely for an all-access caller", () => {
    const plan = planFindByLabel({ appId: "alpha", key: "k" })!;
    expect(plan.serverWhere).toEqual([]);
    expect(compiled(postgres, "pg", { appId: "alpha", key: "k" }).sql).not.toMatch(
      /"record_type"/,
    );
  });

  it("continues from a page token with the keyset chain over both keys", () => {
    const token = encodePageToken({
      order: "value.asc.last,record_id.asc.last",
      keys: [
        { isNull: false, value: "m" },
        { isNull: false, value: "rec5" },
      ],
    });
    const q = compiled(postgres, "pg", { appId: "alpha", key: "k", cursor: token });
    expect(q.sql).toMatch(/"value" is null or "value" > /);
    expect(q.sql).toMatch(/"record_id" is null or "record_id" > /);
    expect(q.parameters).toContain("m");
    expect(q.parameters).toContain("rec5");
  });

  it("rejects a malformed token rather than silently answering the first page", () => {
    // The grammar's contract, and a change from the hand-written path, which
    // treated an unreadable token as "start over". A caller that asked to
    // continue and got the beginning has no way to notice, and pages forever.
    expect(() =>
      planFindByLabel({ appId: "alpha", key: "k", cursor: "hand-edited-nonsense" }),
    ).toThrow(QueryParseError);
  });

  it("rejects a token cut under a different ordering", () => {
    const wrong = encodePageToken({
      order: "value.desc.last,record_id.asc.last",
      keys: [
        { isNull: false, value: "m" },
        { isNull: false, value: rid("rec5") },
      ],
    });
    expect(() => planFindByLabel({ appId: "alpha", key: "k", cursor: wrong })).toThrow(
      /different ordering/,
    );
  });
});
