/**
 * /api/config — the ~/.starkeep/config.json read/write endpoint — plus region
 * derivation from userPoolId. (Plan §8, Tier 0/1.)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest, NextResponse } from "next/server";
import { jsonRequest, makeDataDir, writeAdminConfig } from "./helpers";

let GET: () => Promise<NextResponse>;
let PATCH: (req: NextRequest) => Promise<NextResponse>;
let DEFAULT_APPS_DIR: string;
let dataDir: string;
let configPath: string;

beforeAll(async () => {
  dataDir = makeDataDir();
  configPath = join(dataDir, "config.json");
  process.env.STARKEEP_DATA_DIR = dataDir;
  ({ GET, PATCH } = await import("../app/api/config/route"));
  ({ DEFAULT_APPS_DIR } = await import("../src/lib/exec-commands"));
});

function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
}

const patch = (body: unknown) => PATCH(jsonRequest("/api/config", body, "PATCH"));

describe("GET seeding", () => {
  it("first read with no config file seeds appParentDirs with the default apps dir", async () => {
    expect(existsSync(configPath)).toBe(false);
    const res = await GET();
    expect(res.status).toBe(200);
    const { config } = (await res.json()) as { config: Record<string, unknown> };
    expect(config.appParentDirs).toEqual([DEFAULT_APPS_DIR]);
    // Seeding is persisted, not just reported.
    expect(onDisk().appParentDirs).toEqual([DEFAULT_APPS_DIR]);
  });

  it("an explicitly empty appParentDirs list is left alone (user cleared it)", async () => {
    writeAdminConfig(dataDir, { appParentDirs: [] });
    const res = await GET();
    const { config } = (await res.json()) as { config: Record<string, unknown> };
    expect(config.appParentDirs).toEqual([]);
    expect(onDisk().appParentDirs).toEqual([]);
  });
});

describe("PATCH wizard-state persistence", () => {
  it("shallow-merges the patch into the existing file", async () => {
    writeAdminConfig(dataDir, { appParentDirs: [], stackPrefix: "sk" });
    const res = await patch({ userPoolId: "us-east-2_AbCdEf", stage: "dev" });
    expect(res.status).toBe(200);
    const { config } = (await res.json()) as { config: Record<string, unknown> };
    expect(config).toMatchObject({
      appParentDirs: [],
      stackPrefix: "sk",
      userPoolId: "us-east-2_AbCdEf",
      stage: "dev",
    });
    expect(onDisk()).toMatchObject({ userPoolId: "us-east-2_AbCdEf", stackPrefix: "sk" });
  });

  it("a null value deletes the field (wizard back-navigation invalidation)", async () => {
    await patch({ stage: null });
    expect(onDisk()).not.toHaveProperty("stage");
    expect(onDisk()).toHaveProperty("userPoolId");
  });

  it("never persists region or s3Region — region is derived from userPoolId", async () => {
    const res = await patch({ region: "us-west-1", s3Region: "us-west-1", s3Bucket: "b" });
    const { config } = (await res.json()) as { config: Record<string, unknown> };
    expect(config).not.toHaveProperty("region");
    expect(config).not.toHaveProperty("s3Region");
    expect(config.s3Bucket).toBe("b");
    expect(onDisk()).not.toHaveProperty("region");
    expect(onDisk()).not.toHaveProperty("s3Region");
  });

  it("rejects a non-JSON body with 400", async () => {
    const res = await patch("not json {");
    expect(res.status).toBe(400);
  });
});

describe("regionFromUserPoolId", () => {
  it("derives the region prefix from a Cognito user-pool id", async () => {
    const { regionFromUserPoolId, getRegion } = await import("../src/lib/cloud-config");
    expect(regionFromUserPoolId("us-east-2_AbCdEf123")).toBe("us-east-2");
    expect(regionFromUserPoolId("eu-central-1_Zz9")).toBe("eu-central-1");
    expect(getRegion({ userPoolId: "us-east-2_AbCdEf123" })).toBe("us-east-2");
  });

  it("returns empty for missing or malformed ids rather than guessing", async () => {
    const { regionFromUserPoolId } = await import("../src/lib/cloud-config");
    expect(regionFromUserPoolId("")).toBe("");
    expect(regionFromUserPoolId("no-underscore-here")).toBe("");
  });
});
