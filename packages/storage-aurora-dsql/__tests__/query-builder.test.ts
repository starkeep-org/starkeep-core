import { describe, it, expect } from "vitest";
import type { Query } from "@starkeep/storage-adapter";
import { buildPostgresQuery } from "../src/query-builder.js";

describe("buildPostgresQuery (compile-only, no database)", () => {
  it("selects everything from shared.records ordered by id by default", () => {
    const { text, values } = buildPostgresQuery({});
    expect(text).toBe('select * from "shared"."records" order by "id" asc');
    expect(values).toEqual([]);
  });

  it("filters by type with a $1 placeholder", () => {
    const { text, values } = buildPostgresQuery({ type: "jpg" });
    expect(text).toContain('where "type" = $1');
    expect(values).toEqual(["jpg"]);
  });

  it("maps camelCase external fields to snake_case columns", () => {
    const query: Query = {
      filters: [
        { field: "originAppId", operator: "eq", value: "photos" },
        { field: "sizeBytes", operator: "gt", value: 100 },
      ],
      sort: [{ field: "updatedAt", direction: "desc" }],
    };
    const { text, values } = buildPostgresQuery(query);
    expect(text).toContain('"origin_app_id" = $1');
    expect(text).toContain('"size_bytes" > $2');
    expect(text).toContain('order by "updated_at" desc');
    expect(values).toEqual(["photos", 100]);
  });

  it("passes unknown fields through unmapped", () => {
    const { text } = buildPostgresQuery({
      filters: [{ field: "custom_col", operator: "eq", value: 1 }],
    });
    expect(text).toContain('"custom_col" = $1');
  });

  it("supports the full operator set", () => {
    const ops: Array<[string, unknown, string]> = [
      ["eq", 1, "="],
      ["neq", 1, "!="],
      ["gt", 1, ">"],
      ["gte", 1, ">="],
      ["lt", 1, "<"],
      ["lte", 1, "<="],
    ];
    for (const [operator, value, sqlOp] of ops) {
      const { text } = buildPostgresQuery({
        filters: [{ field: "version", operator: operator as never, value }],
      });
      expect(text, operator).toContain(`"version" ${sqlOp} $1`);
    }
  });

  it("expands `in` filters to one placeholder per element", () => {
    const { text, values } = buildPostgresQuery({
      filters: [{ field: "type", operator: "in", value: ["jpg", "png"] }],
    });
    expect(text).toContain('"type" in ($1, $2)');
    expect(values).toEqual(["jpg", "png"]);
  });

  it("wraps `like` values in wildcards", () => {
    const { values } = buildPostgresQuery({
      filters: [{ field: "originalFilename", operator: "like", value: "cat" }],
    });
    expect(values).toEqual(["%cat%"]);
  });

  it("renders isNull / isNotNull without parameters", () => {
    const isNull = buildPostgresQuery({
      filters: [{ field: "deletedAt", operator: "isNull" }],
    });
    expect(isNull.text).toContain('"deleted_at" is null');
    expect(isNull.values).toEqual([]);
    const isNotNull = buildPostgresQuery({
      filters: [{ field: "parentId", operator: "isNotNull" }],
    });
    expect(isNotNull.text).toContain('"parent_id" is not null');
  });

  it("applies the cursor as id > $n", () => {
    const { text, values } = buildPostgresQuery({ type: "jpg", cursor: "abc" } as Query);
    expect(text).toContain('"id" > $2');
    expect(values).toEqual(["jpg", "abc"]);
  });

  it("requests limit+1 rows so the adapter can detect hasMore", () => {
    const { text, values } = buildPostgresQuery({ limit: 50 });
    expect(text).toContain("limit $1");
    expect(values).toEqual([51]);
  });
});
