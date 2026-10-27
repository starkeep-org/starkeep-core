/**
 * The record-type scope: a mobile app's exchange sees only the types its
 * manifest grants. Every read through the scoped compiler must be narrowed, or
 * a watermark or digest would count rows the phone never receives.
 */
import { describe, expect, it } from "vitest";
import { typeScopedCompiler } from "../src/query-builder.js";

const USER = "user-a";
const qb = typeScopedCompiler(USER, ["video/mp4", "image/jpeg"]);

describe("reads of records", () => {
  it("narrow a select to the scope's types, and keep the owner", () => {
    const q = qb.selectFrom("shared.records").selectAll().where("id", "=", "r1").compile();
    expect(q.sql).toBe(
      'select * from "shared"."records" where "id" = $1 and "shared"."records"."type" in ($2, $3) and "shared"."records"."user_id" = $4',
    );
    expect(q.parameters).toEqual(["r1", "image/jpeg", "video/mp4", USER]);
  });

  it("narrow a grouped watermark read", () => {
    const q = qb
      .selectFrom("shared.records")
      .select(({ fn }) => ["node_id", fn.max("updated_at").as("m")])
      .groupBy("node_id")
      .compile();
    expect(q.sql).toContain('"shared"."records"."type" in ($1, $2)');
  });

  it("qualify by the alias when the table has one", () => {
    const q = qb.selectFrom("shared.records as r").select("r.id").compile();
    expect(q.sql).toContain('"r"."type" in');
  });
});

describe("reads of labels", () => {
  it("narrow labels to records of the scope's types, of the same user", () => {
    const q = qb.selectFrom("shared.record_labels").selectAll().compile();
    expect(q.sql).toBe(
      'select * from "shared"."record_labels" where "shared"."record_labels"."record_id" in ' +
        '(select "shared"."records"."id" from "shared"."records" where "shared"."records"."type" in ($1, $2) and "shared"."records"."user_id" = $3) ' +
        'and "shared"."record_labels"."user_id" = $4',
    );
  });
});

describe("writes", () => {
  it("narrow updates and deletes, so a scoped caller cannot touch a foreign type", () => {
    const update = qb
      .updateTable("shared.records")
      .set({ deleted_at: "x" })
      .where("id", "=", "r1")
      .compile();
    expect(update.sql).toContain('"shared"."records"."type" in');
    const del = qb.deleteFrom("shared.record_labels").where("record_id", "=", "r1").compile();
    expect(del.sql).toContain('"shared"."record_labels"."record_id" in (select');
  });

  it("leave inserts alone; the caller checks a push before writing it", () => {
    const q = qb.insertInto("shared.records").values({ id: "r1", type: "text/markdown" }).compile();
    expect(q.sql).not.toContain('"type" in');
  });
});

describe("other tables and empty scopes", () => {
  it("leave every other table unnarrowed", () => {
    const q = qb.selectFrom("shared.access_grants").selectAll().compile();
    expect(q.sql).toBe('select * from "shared"."access_grants"');
  });

  it("match nothing for an empty scope", () => {
    const q = typeScopedCompiler(USER, []).selectFrom("shared.records").selectAll().compile();
    expect(q.sql).toContain("1 = 0");
  });

  it("refuse a join on a scoped table rather than compile an unscoped read", () => {
    expect(() =>
      qb
        .selectFrom("shared.access_grants")
        .innerJoin("shared.records", "shared.records.type", "shared.access_grants.type_id")
        .selectAll()
        .compile(),
    ).toThrow(/join/);
  });
});
