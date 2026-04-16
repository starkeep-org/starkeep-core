/**
 * Unit tests for AWS Settings Repository
 *
 * Note: These tests use mocks. For integration tests with real Postgres,
 * use a separate test file with a test database.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AwsSettingsRepository } from "../src/repositories/aws-settings";
import type { Pool, QueryResult } from "pg";

// Mock pg pool
const mockQuery = vi.fn();
const mockPool = {
  query: mockQuery,
} as unknown as Pool;

// Mock the client module before importing repository
vi.mock("../src/client.js", () => ({
  getPool: vi.fn(() => mockPool),
}));

describe("AwsSettingsRepository", () => {
  let repository: AwsSettingsRepository;

  beforeEach(() => {
    repository = new AwsSettingsRepository();
    mockQuery.mockClear();
  });

  describe("create", () => {
    it("should create new AWS settings with required fields", async () => {
      const mockResult: QueryResult = {
        rows: [
          {
            id: "setting-123",
            customer_id: "customer-123",
            account_id: "123456789012",
            default_region: "us-east-1",
            allowed_regions: null,
            stack_prefix: "app",
            role_arn: "arn:aws:iam::123456789012:role/StarkeeperAccess",
            external_id: "test-external-id",
            execution_role_arn: "arn:aws:iam::123456789012:role/StarkeeperCloudFormationExecution",
            permission_boundary_arn: "arn:aws:iam::123456789012:policy/StarkeeperPermissionBoundary",
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        command: "INSERT",
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      mockQuery.mockResolvedValueOnce(mockResult);

      const result = await repository.create({
        customer_id: "customer-123",
        account_id: "123456789012",
        role_arn: "arn:aws:iam::123456789012:role/StarkeeperAccess",
        external_id: "test-external-id",
        execution_role_arn: "arn:aws:iam::123456789012:role/StarkeeperCloudFormationExecution",
        permission_boundary_arn: "arn:aws:iam::123456789012:policy/StarkeeperPermissionBoundary",
      });

      expect(result.customer_id).toBe("customer-123");
      expect(result.account_id).toBe("123456789012");
      expect(result.role_arn).toBe("arn:aws:iam::123456789012:role/StarkeeperAccess");
      expect(result.external_id).toBe("test-external-id");
      expect(result.execution_role_arn).toBe("arn:aws:iam::123456789012:role/StarkeeperCloudFormationExecution");
      expect(result.permission_boundary_arn).toBe("arn:aws:iam::123456789012:policy/StarkeeperPermissionBoundary");
    });

    it("should use default values for optional fields", async () => {
      const mockResult: QueryResult = {
        rows: [
          {
            id: "setting-123",
            customer_id: "customer-123",
            account_id: "123456789012",
            default_region: "us-east-1",
            allowed_regions: null,
            stack_prefix: "app",
            role_arn: "arn:aws:iam::123456789012:role/StarkeeperAccess",
            external_id: "test-external-id",
            execution_role_arn: null,
            permission_boundary_arn: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        command: "INSERT",
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      mockQuery.mockResolvedValueOnce(mockResult);

      const result = await repository.create({
        customer_id: "customer-123",
        account_id: "123456789012",
        role_arn: "arn:aws:iam::123456789012:role/StarkeeperAccess",
        external_id: "test-external-id",
      });

      // Verify query was called with correct parameters
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO aws_settings"),
        expect.arrayContaining([
          "customer-123",
          "123456789012",
          "us-east-1", // default region
          null, // allowed_regions
          "app", // default stack prefix
          "arn:aws:iam::123456789012:role/StarkeeperAccess",
          "test-external-id",
          null, // execution_role_arn
          null, // permission_boundary_arn
        ])
      );

      expect(result.default_region).toBe("us-east-1");
      expect(result.stack_prefix).toBe("app");
    });

    it("should store allowed regions array", async () => {
      const mockResult: QueryResult = {
        rows: [
          {
            id: "setting-123",
            customer_id: "customer-123",
            account_id: "123456789012",
            default_region: "us-east-1",
            allowed_regions: ["us-east-1", "us-west-2"],
            stack_prefix: "myapp",
            role_arn: "arn:aws:iam::123456789012:role/StarkeeperAccess",
            external_id: "test-external-id",
            execution_role_arn: null,
            permission_boundary_arn: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        command: "INSERT",
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      mockQuery.mockResolvedValueOnce(mockResult);

      const result = await repository.create({
        customer_id: "customer-123",
        account_id: "123456789012",
        role_arn: "arn:aws:iam::123456789012:role/StarkeeperAccess",
        external_id: "test-external-id",
        allowed_regions: ["us-east-1", "us-west-2"],
        stack_prefix: "myapp",
      });

      expect(result.allowed_regions).toEqual(["us-east-1", "us-west-2"]);
      expect(result.stack_prefix).toBe("myapp");
    });
  });

  describe("findByCustomerId", () => {
    it("should find settings by customer ID", async () => {
      const mockResult: QueryResult = {
        rows: [
          {
            id: "setting-123",
            customer_id: "customer-123",
            account_id: "123456789012",
            default_region: "us-east-1",
            allowed_regions: null,
            stack_prefix: "app",
            role_arn: "arn:aws:iam::123456789012:role/StarkeeperAccess",
            external_id: "test-external-id",
            execution_role_arn: null,
            permission_boundary_arn: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      mockQuery.mockResolvedValueOnce(mockResult);

      const result = await repository.findByCustomerId("customer-123");

      expect(result).not.toBeNull();
      expect(result?.customer_id).toBe("customer-123");
      expect(mockQuery).toHaveBeenCalledWith(
        "SELECT * FROM aws_settings WHERE customer_id = $1",
        ["customer-123"]
      );
    });

    it("should return null when customer not found", async () => {
      const mockResult: QueryResult = {
        rows: [],
        command: "SELECT",
        rowCount: 0,
        oid: 0,
        fields: [],
      };

      mockQuery.mockResolvedValueOnce(mockResult);

      const result = await repository.findByCustomerId("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("update", () => {
    it("should update AWS settings", async () => {
      const mockResult: QueryResult = {
        rows: [
          {
            id: "setting-123",
            customer_id: "customer-123",
            account_id: "123456789012",
            default_region: "us-west-2",
            allowed_regions: ["us-west-2"],
            stack_prefix: "newapp",
            role_arn: "arn:aws:iam::123456789012:role/StarkeeperAccess",
            external_id: "new-external-id",
            execution_role_arn: "arn:aws:iam::123456789012:role/StarkeeperCloudFormationExecution",
            permission_boundary_arn: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        command: "UPDATE",
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      mockQuery.mockResolvedValueOnce(mockResult);

      const result = await repository.update("customer-123", {
        default_region: "us-west-2",
        allowed_regions: ["us-west-2"],
        stack_prefix: "newapp",
        external_id: "new-external-id",
      });

      expect(result.default_region).toBe("us-west-2");
      expect(result.allowed_regions).toEqual(["us-west-2"]);
      expect(result.stack_prefix).toBe("newapp");
      expect(result.external_id).toBe("new-external-id");
    });

    it("should throw error when no fields to update", async () => {
      await expect(repository.update("customer-123", {})).rejects.toThrow(
        "No fields to update"
      );
    });

    it("should throw error when settings not found", async () => {
      const mockResult: QueryResult = {
        rows: [],
        command: "UPDATE",
        rowCount: 0,
        oid: 0,
        fields: [],
      };

      mockQuery.mockResolvedValueOnce(mockResult);

      await expect(
        repository.update("nonexistent", { stack_prefix: "new" })
      ).rejects.toThrow("AWS settings not found");
    });
  });

  describe("upsert", () => {
    it("should create new settings when they don't exist", async () => {
      // findByCustomerId returns null
      mockQuery.mockResolvedValueOnce({
        rows: [],
        command: "SELECT",
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      // create returns new settings
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "setting-123",
            customer_id: "customer-123",
            account_id: "123456789012",
            default_region: "us-east-1",
            allowed_regions: null,
            stack_prefix: "app",
            role_arn: "arn:aws:iam::123456789012:role/StarkeeperAccess",
            external_id: "test-external-id",
            execution_role_arn: null,
            permission_boundary_arn: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        command: "INSERT",
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const result = await repository.upsert({
        customer_id: "customer-123",
        account_id: "123456789012",
        role_arn: "arn:aws:iam::123456789012:role/StarkeeperAccess",
        external_id: "test-external-id",
      });

      expect(result.customer_id).toBe("customer-123");
      expect(mockQuery).toHaveBeenCalledTimes(2); // SELECT + INSERT
    });

    it("should update existing settings when they exist", async () => {
      // findByCustomerId returns existing settings
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "setting-123",
            customer_id: "customer-123",
            account_id: "123456789012",
            default_region: "us-east-1",
            allowed_regions: null,
            stack_prefix: "app",
            role_arn: "arn:aws:iam::123456789012:role/OldRole",
            external_id: "old-external-id",
            execution_role_arn: null,
            permission_boundary_arn: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // update returns updated settings
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "setting-123",
            customer_id: "customer-123",
            account_id: "123456789012",
            default_region: "us-east-1",
            allowed_regions: null,
            stack_prefix: "app",
            role_arn: "arn:aws:iam::123456789012:role/NewRole",
            external_id: "new-external-id",
            execution_role_arn: null,
            permission_boundary_arn: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        command: "UPDATE",
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const result = await repository.upsert({
        customer_id: "customer-123",
        account_id: "123456789012",
        role_arn: "arn:aws:iam::123456789012:role/NewRole",
        external_id: "new-external-id",
      });

      expect(result.role_arn).toBe("arn:aws:iam::123456789012:role/NewRole");
      expect(result.external_id).toBe("new-external-id");
      expect(mockQuery).toHaveBeenCalledTimes(2); // SELECT + UPDATE
    });
  });

  describe("delete", () => {
    it("should delete settings by customer ID", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [],
        command: "DELETE",
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      await repository.delete("customer-123");

      expect(mockQuery).toHaveBeenCalledWith(
        "DELETE FROM aws_settings WHERE customer_id = $1",
        ["customer-123"]
      );
    });
  });
});
