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

  describe("excludeLabel", () => {
    it("emits a correlated NOT EXISTS against the labels table", () => {
      const { text, values } = buildPostgresQuery({
        excludeLabel: { appId: "photos", key: "rendition" },
      });
      expect(text).toContain("not exists");
      expect(text).toContain('"shared"."record_labels"');
      // Correlated on the record id — an uncorrelated subquery would exclude
      // every record as soon as *any* record carried the label.
      expect(text).toMatch(/"record_id" = "shared"\."records"\."id"/);
      expect(values).toEqual(["photos", "rendition"]);
    });

    // A retracted rendition label means the record is no longer a rendition.
    // Without this clause the dead row would keep it hidden from the grid
    // permanently, and nothing would ever un-hide it.
    it("ignores tombstoned label rows", () => {
      const { text } = buildPostgresQuery({
        excludeLabel: { appId: "photos", key: "rendition" },
      });
      expect(text).toContain('"deleted_at" is null');
    });

    // NOT EXISTS rather than a LEFT JOIN: a record can hold several values of
    // one key, and a join would multiply its row before the null test.
    it("does not join, so a record with many labels cannot be duplicated", () => {
      const { text } = buildPostgresQuery({
        excludeLabel: { appId: "photos", key: "rendition" },
      });
      expect(text).not.toContain("left join");
    });
  });
});
