import { describe, it, expect } from "vitest";
import { createHLCClock } from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createApiRouter } from "../src/api-router.js";
import { createSharedSpaceApi } from "../src/shared-space-api.js";
import { parseQueryParams } from "../src/helpers/query-params.js";
import { formatPaginatedResponse } from "../src/helpers/pagination.js";
import { RouteNotFoundError } from "../src/errors.js";
import type { ApiEndpointDefinition, ApiRequest } from "../src/types.js";

describe("createApiRouter", () => {
  it("should register and resolve endpoints", () => {
    const router = createApiRouter();
    const endpoint: ApiEndpointDefinition = {
      namespace: "@starkeep/photos",
      version: "v1",
      path: "albums/list",
      method: "GET",
      handler: async () => ({ status: 200, body: [] }),
    };

    router.register(endpoint);

    const resolved = router.resolve(
      "@starkeep/photos",
      "v1",
      "albums/list",
      "GET",
    );
    expect(resolved).toBe(endpoint);
  });

  it("should return undefined for unregistered route", () => {
    const router = createApiRouter();

    const resolved = router.resolve(
      "@starkeep/photos",
      "v1",
      "nonexistent",
      "GET",
    );
    expect(resolved).toBeUndefined();
  });

  it("should throw on duplicate registration", () => {
    const router = createApiRouter();
    const endpoint: ApiEndpointDefinition = {
      namespace: "@starkeep/photos",
      version: "v1",
      path: "albums/list",
      method: "GET",
      handler: async () => ({ status: 200, body: [] }),
    };

    router.register(endpoint);
    expect(() => router.register(endpoint)).toThrow("already registered");
  });

  it("should list all endpoints", () => {
    const router = createApiRouter();
    router.register({
      namespace: "@test",
      version: "v1",
      path: "a",
      method: "GET",
      handler: async () => ({ status: 200, body: null }),
    });
    router.register({
      namespace: "@test",
      version: "v1",
      path: "b",
      method: "POST",
      handler: async () => ({ status: 200, body: null }),
    });

    expect(router.listEndpoints()).toHaveLength(2);
  });

  it("should distinguish by method", () => {
    const router = createApiRouter();
    const getEndpoint: ApiEndpointDefinition = {
      namespace: "@test",
      version: "v1",
      path: "items",
      method: "GET",
      handler: async () => ({ status: 200, body: "get" }),
    };
    const postEndpoint: ApiEndpointDefinition = {
      namespace: "@test",
      version: "v1",
      path: "items",
      method: "POST",
      handler: async () => ({ status: 201, body: "post" }),
    };

    router.register(getEndpoint);
    router.register(postEndpoint);

    expect(router.resolve("@test", "v1", "items", "GET")).toBe(getEndpoint);
    expect(router.resolve("@test", "v1", "items", "POST")).toBe(postEndpoint);
  });
});

describe("createSharedSpaceApi", () => {
  function createTestApi() {
    const databaseAdapter = new MockDatabaseAdapter();
    const objectStorageAdapter = new MockObjectStorageAdapter();
    const clock = createHLCClock({
      nodeId: "test",
      wallClockFunction: () => 1000,
    });

    const api = createSharedSpaceApi({
      databaseAdapter,
      objectStorageAdapter,
      clock,
      ownerId: "test-owner",
    });

    return { api, databaseAdapter, objectStorageAdapter };
  }

  it("should handle a registered route", async () => {
    const { api } = createTestApi();

    api.router.register({
      namespace: "@test/photos",
      version: "v1",
      path: "albums",
      method: "GET",
      handler: async () => ({
        status: 200,
        body: { albums: [] },
      }),
    });

    const request: ApiRequest = {
      path: "@test/photos:v1/albums",
      method: "GET",
      subject: { subjectType: "user", subjectId: "u1" },
    };

    const response = await api.handleRequest(request);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ albums: [] });
  });

  it("should throw RouteNotFoundError for unregistered route", async () => {
    const { api } = createTestApi();

    const request: ApiRequest = {
      path: "@test/photos:v1/nonexistent",
      method: "GET",
      subject: { subjectType: "user", subjectId: "u1" },
    };

    await expect(api.handleRequest(request)).rejects.toThrow(
      RouteNotFoundError,
    );
  });

  it("should return 400 for invalid route format", async () => {
    const { api } = createTestApi();

    const request: ApiRequest = {
      path: "invalid-path-no-colon",
      method: "GET",
      subject: { subjectType: "user", subjectId: "u1" },
    };

    const response = await api.handleRequest(request);
    expect(response.status).toBe(400);
  });

  it("should handle handler errors gracefully", async () => {
    const { api } = createTestApi();

    api.router.register({
      namespace: "@test/photos",
      version: "v1",
      path: "error",
      method: "GET",
      handler: async () => {
        throw new Error("Something went wrong");
      },
    });

    const request: ApiRequest = {
      path: "@test/photos:v1/error",
      method: "GET",
      subject: { subjectType: "user", subjectId: "u1" },
    };

    const response = await api.handleRequest(request);
    expect(response.status).toBe(500);
  });

  it("should pass context to handlers", async () => {
    const { api } = createTestApi();

    api.router.register({
      namespace: "@test",
      version: "v1",
      path: "whoami",
      method: "GET",
      handler: async (_request, context) => ({
        status: 200,
        body: { ownerId: context.ownerId },
      }),
    });

    const request: ApiRequest = {
      path: "@test:v1/whoami",
      method: "GET",
      subject: { subjectType: "user", subjectId: "u1" },
    };

    const response = await api.handleRequest(request);
    expect(response.body).toEqual({ ownerId: "test-owner" });
  });
});

describe("parseQueryParams", () => {
  it("should return defaults for undefined query", () => {
    const result = parseQueryParams(undefined);
    expect(result.limit).toBe(50);
    expect(result.types).toBeUndefined();
  });

  it("should parse types as comma-separated list", () => {
    const result = parseQueryParams({ types: "photo,document" });
    expect(result.types).toEqual(["photo", "document"]);
  });

  it("should parse limit and cursor", () => {
    const result = parseQueryParams({ limit: "25", cursor: "abc" });
    expect(result.limit).toBe(25);
    expect(result.cursor).toBe("abc");
  });

  it("should clamp limit to valid range", () => {
    expect(parseQueryParams({ limit: "0" }).limit).toBe(1);
    expect(parseQueryParams({ limit: "5000" }).limit).toBe(1000);
  });

  it("should parse sort parameters", () => {
    const result = parseQueryParams({ sort: "createdAt", order: "desc" });
    expect(result.sortField).toBe("createdAt");
    expect(result.sortDirection).toBe("desc");
  });
});

describe("formatPaginatedResponse", () => {
  it("should format query result into paginated response", () => {
    const result = formatPaginatedResponse({
      records: [{ id: "1" } as any, { id: "2" } as any],
      nextCursor: "cursor-2",
      hasMore: true,
    });

    expect(result.data).toHaveLength(2);
    expect(result.pagination.nextCursor).toBe("cursor-2");
    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.count).toBe(2);
  });
});
