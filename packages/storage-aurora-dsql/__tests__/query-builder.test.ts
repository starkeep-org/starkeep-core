import { describe, it, expect } from "vitest";
import { buildPostgresQuery } from "../src/query-builder.js";
import type { Query } from "@starkeep/storage-adapter";

describe("buildPostgresQuery", () => {
  it("should build a simple query with no filters", () => {
    const query: Query = {};
    const result = buildPostgresQuery(query);

    expect(result.text).toBe("SELECT * FROM records ORDER BY id ASC");
    expect(result.values).toEqual([]);
  });

  it("should filter by type", () => {
    const query: Query = { type: "@test/photo" };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE type = $1 ORDER BY id ASC",
    );
    expect(result.values).toEqual(["@test/photo"]);
  });

  it("should handle eq filter", () => {
    const query: Query = {
      filters: [{ field: "ownerId", operator: "eq", value: "user-1" }],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE owner_id = $1 ORDER BY id ASC",
    );
    expect(result.values).toEqual(["user-1"]);
  });

  it("should handle neq filter", () => {
    const query: Query = {
      filters: [{ field: "syncStatus", operator: "neq", value: "synced" }],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE sync_status != $1 ORDER BY id ASC",
    );
    expect(result.values).toEqual(["synced"]);
  });

  it("should handle gt filter", () => {
    const query: Query = {
      filters: [{ field: "version", operator: "gt", value: 3 }],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE version > $1 ORDER BY id ASC",
    );
    expect(result.values).toEqual([3]);
  });

  it("should handle gte filter", () => {
    const query: Query = {
      filters: [{ field: "version", operator: "gte", value: 2 }],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE version >= $1 ORDER BY id ASC",
    );
    expect(result.values).toEqual([2]);
  });

  it("should handle lt filter", () => {
    const query: Query = {
      filters: [{ field: "sizeBytes", operator: "lt", value: 1024 }],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE size_bytes < $1 ORDER BY id ASC",
    );
    expect(result.values).toEqual([1024]);
  });

  it("should handle lte filter", () => {
    const query: Query = {
      filters: [{ field: "sizeBytes", operator: "lte", value: 2048 }],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE size_bytes <= $1 ORDER BY id ASC",
    );
    expect(result.values).toEqual([2048]);
  });

  it("should handle in filter with multiple values", () => {
    const query: Query = {
      filters: [
        { field: "type", operator: "in", value: ["@test/photo", "@test/video", "@test/audio"] },
      ],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE type IN ($1, $2, $3) ORDER BY id ASC",
    );
    expect(result.values).toEqual(["@test/photo", "@test/video", "@test/audio"]);
  });

  it("should handle like filter with wrapping wildcards", () => {
    const query: Query = {
      filters: [{ field: "type", operator: "like", value: "photo" }],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE type LIKE $1 ORDER BY id ASC",
    );
    expect(result.values).toEqual(["%photo%"]);
  });

  it("should handle multiple filters with correct parameter numbering", () => {
    const query: Query = {
      type: "@test/photo",
      filters: [
        { field: "ownerId", operator: "eq", value: "user-1" },
        { field: "version", operator: "gte", value: 2 },
      ],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE type = $1 AND owner_id = $2 AND version >= $3 ORDER BY id ASC",
    );
    expect(result.values).toEqual(["@test/photo", "user-1", 2]);
  });

  it("should handle ascending sort", () => {
    const query: Query = {
      sort: [{ field: "createdAt", direction: "asc" }],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records ORDER BY created_at ASC",
    );
    expect(result.values).toEqual([]);
  });

  it("should handle descending sort", () => {
    const query: Query = {
      sort: [{ field: "updatedAt", direction: "desc" }],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records ORDER BY updated_at DESC",
    );
    expect(result.values).toEqual([]);
  });

  it("should handle multiple sort fields", () => {
    const query: Query = {
      sort: [
        { field: "type", direction: "asc" },
        { field: "createdAt", direction: "desc" },
      ],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records ORDER BY type ASC, created_at DESC",
    );
    expect(result.values).toEqual([]);
  });

  it("should handle cursor pagination", () => {
    const query: Query = {
      cursor: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE id > $1 ORDER BY id ASC",
    );
    expect(result.values).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
  });

  it("should handle limit with +1 for hasMore detection", () => {
    const query: Query = { limit: 10 };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records ORDER BY id ASC LIMIT $1",
    );
    expect(result.values).toEqual([11]);
  });

  it("should handle cursor and limit together", () => {
    const query: Query = {
      cursor: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      limit: 5,
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE id > $1 ORDER BY id ASC LIMIT $2",
    );
    expect(result.values).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAV", 6]);
  });

  it("should handle a complex query with all options", () => {
    const query: Query = {
      type: "@test/photo",
      filters: [
        { field: "ownerId", operator: "eq", value: "user-1" },
        { field: "syncStatus", operator: "in", value: ["local", "pending"] },
      ],
      sort: [{ field: "updatedAt", direction: "desc" }],
      cursor: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      limit: 20,
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE type = $1 AND owner_id = $2 AND sync_status IN ($3, $4) AND id > $5 ORDER BY updated_at DESC LIMIT $6",
    );
    expect(result.values).toEqual([
      "@test/photo",
      "user-1",
      "local",
      "pending",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      21,
    ]);
  });

  it("should map camelCase fields to snake_case columns", () => {
    const query: Query = {
      filters: [
        { field: "contentHash", operator: "eq", value: "sha256:abc" },
        { field: "objectStorageKey", operator: "eq", value: "key-123" },
        { field: "mimeType", operator: "eq", value: "image/jpeg" },
      ],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE content_hash = $1 AND object_storage_key = $2 AND mime_type = $3 ORDER BY id ASC",
    );
    expect(result.values).toEqual(["sha256:abc", "key-123", "image/jpeg"]);
  });

  it("should pass through unmapped field names as-is", () => {
    const query: Query = {
      filters: [{ field: "custom_field", operator: "eq", value: "test" }],
    };
    const result = buildPostgresQuery(query);

    expect(result.text).toBe(
      "SELECT * FROM records WHERE custom_field = $1 ORDER BY id ASC",
    );
    expect(result.values).toEqual(["test"]);
  });
});
