import { describe, it, expect } from "vitest";
import {
  buildStackName,
  buildBucketName,
  buildClusterIdentifier,
  parseStackName,
} from "../src/resource-naming.js";

describe("buildStackName", () => {
  it("produces correct format", () => {
    const result = buildStackName("starkeep", "user-abc-123");

    expect(result).toBe("starkeep-user-user-abc-123");
  });

  it("includes both project name and user id", () => {
    const result = buildStackName("myproject", "alice");

    expect(result).toBe("myproject-user-alice");
  });
});

describe("buildBucketName", () => {
  it("produces valid S3 bucket name with lowercase and hyphens", () => {
    const result = buildBucketName("StarKeep", "User-ABC");

    expect(result).toBe("starkeep-user-abc-data");
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });

  it("replaces invalid characters with hyphens", () => {
    const result = buildBucketName("my_project", "user.name");

    expect(result).toBe("my-project-user-name-data");
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("buildClusterIdentifier", () => {
  it("produces valid cluster identifier", () => {
    const result = buildClusterIdentifier("starkeep", "user-abc");

    expect(result).toBe("starkeep-user-abc-cluster");
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("parseStackName", () => {
  it("correctly extracts projectName and userId", () => {
    const result = parseStackName("starkeep-user-abc-123");

    expect(result).not.toBeNull();
    expect(result!.projectName).toBe("starkeep");
    expect(result!.userId).toBe("abc-123");
  });

  it("handles project names with hyphens before the separator", () => {
    const result = parseStackName("my-app-user-alice");

    expect(result).not.toBeNull();
    expect(result!.projectName).toBe("my-app");
    expect(result!.userId).toBe("alice");
  });

  it("returns null for invalid format without separator", () => {
    const result = parseStackName("invalid-stack-name");

    expect(result).toBeNull();
  });

  it("returns null for empty project name", () => {
    const result = parseStackName("-user-alice");

    expect(result).toBeNull();
  });

  it("returns null for empty user id", () => {
    const result = parseStackName("starkeep-user-");

    expect(result).toBeNull();
  });
});
