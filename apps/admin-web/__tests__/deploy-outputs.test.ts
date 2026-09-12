/**
 * GET /api/exec/deploy-outputs — what the wizard reads back after an install.
 *
 * The route is three guards over one file, and each guard is a different answer
 * to "is the cloud there yet?". The dashboard and the wizard both branch on
 * them, so a 404 that should have been a 500 (or the reverse) shows up as the
 * wrong empty state rather than as an error.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDataDir } from "./helpers";

let GET: () => Promise<Response>;
let dataDir: string;
let configPath: string;

beforeAll(async () => {
  dataDir = makeDataDir("adminweb-deploy-outputs-");
  configPath = join(dataDir, "config.json");
  process.env.STARKEEP_DIR = dataDir;
  ({ GET } = await import("../src/routes/exec-deploy-outputs"));
});

beforeEach(() => {
  rmSync(configPath, { force: true });
});

function writeConfig(config: unknown): void {
  writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));
}

describe("before anything is installed", () => {
  it("answers 404 when there is no config file at all", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("not found");
  });

  it("answers 404 when the cloud-data-server outputs are missing", async () => {
    writeConfig({ stackPrefix: "sk", userPoolId: "us-east-2_abc" });
    const res = await GET();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("cloud-data-server");
  });

  it("answers 404 when only half the outputs are there", async () => {
    // A half-failed install leaves exactly this, and reporting it as present
    // would send the wizard on to a step whose inputs do not exist.
    writeConfig({ s3Bucket: "sk-files" });
    expect((await GET()).status).toBe(404);
  });
});

describe("a config that cannot be read", () => {
  it("answers 500, not 404 — an unreadable file is not an absent deployment", async () => {
    writeConfig("{ not json");
    const res = await GET();
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("parse");
  });
});

describe("once the cloud-data-server is installed", () => {
  it("returns the three outputs the wizard needs and nothing else", async () => {
    writeConfig({
      s3Bucket: "sk-files",
      auroraEndpoint: "abc.dsql.us-east-2.on.aws",
      apiGatewayUrl: "https://api.example.com",
      // Deliberately present: the route must not hand the browser the whole
      // config file, which carries role ARNs and pool ids.
      managerRoleArn: "arn:aws:iam::1:role/sk-manager-role",
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      s3Bucket: "sk-files",
      auroraEndpoint: "abc.dsql.us-east-2.on.aws",
      apiGatewayUrl: "https://api.example.com",
    });
  });

  it("answers without apiGatewayUrl for a config written before it was recorded", async () => {
    writeConfig({ s3Bucket: "sk-files", auroraEndpoint: "abc.dsql.us-east-2.on.aws" });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      s3Bucket: "sk-files",
      auroraEndpoint: "abc.dsql.us-east-2.on.aws",
    });
  });
});
