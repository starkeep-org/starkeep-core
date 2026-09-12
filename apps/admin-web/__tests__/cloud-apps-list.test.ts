/**
 * POST /api/apps/cloud/list — which apps the cloud stack has installed.
 *
 * Everything below the guards is a DSQL connection, which is not something a
 * unit test can or should stand up. What the guards decide is whether the
 * operator sees "finish cloud setup first" or a stack trace, and they run in a
 * particular order: the config file first, then its contents, then the
 * credentials in the body. The dashboard's cloud column branches on each.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonRequest, makeDataDir } from "./helpers";

let POST: (req: Request) => Promise<Response>;
let dataDir: string;
let configPath: string;

const CREDS = {
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  sessionToken: "token",
};

const COMPLETE_CONFIG = {
  stackPrefix: "sktest",
  userPoolId: "us-east-2_abc123",
  auroraEndpoint: "abc.dsql.us-east-2.on.aws",
};

beforeAll(async () => {
  dataDir = makeDataDir("adminweb-cloud-list-");
  configPath = join(dataDir, "config.json");
  process.env.STARKEEP_DIR = dataDir;
  const route = await import("../src/routes/apps-cloud-list");
  POST = route.POST;
});

beforeEach(() => {
  rmSync(configPath, { force: true });
});

function writeConfig(config: unknown): void {
  writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));
}

const call = (body: unknown) => POST(jsonRequest("/api/apps/cloud/list", body));

describe("before cloud setup", () => {
  it("answers 400 when there is no config file", async () => {
    const res = await call(CREDS);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("finish cloud setup");
  });

  it("answers 500 when the config file cannot be parsed", async () => {
    // Distinct from "not configured": a corrupt file is the operator's to fix,
    // and telling them to run the wizard again would be the wrong instruction.
    writeConfig("{ not json");
    const res = await call(CREDS);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("not valid JSON");
  });

  it.each([
    ["stackPrefix", { userPoolId: "us-east-2_abc", auroraEndpoint: "abc.dsql.aws" }],
    ["userPoolId", { stackPrefix: "sktest", auroraEndpoint: "abc.dsql.aws" }],
    ["auroraEndpoint", { stackPrefix: "sktest", userPoolId: "us-east-2_abc" }],
  ])("answers 400 when %s is missing", async (_field, config) => {
    writeConfig(config);
    const res = await call(CREDS);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("missing required fields");
  });

  it("treats a userPoolId with no region prefix as missing configuration", async () => {
    // Region is derived from the pool id rather than stored, so a pool id that
    // carries no region is the same defect as no pool id at all. Before this
    // test the route's own copy of the derivation took the whole string as the
    // region, built a DSQL hostname in a region that does not exist, and
    // answered with a connection failure instead of the wizard.
    writeConfig({ ...COMPLETE_CONFIG, userPoolId: "abc123" });
    expect((await call(CREDS)).status).toBe(400);
  });
});

describe("credentials", () => {
  it.each(["accessKeyId", "secretAccessKey", "sessionToken"] as const)(
    "answers 400 when %s is absent from the body",
    async (field) => {
      writeConfig(COMPLETE_CONFIG);
      const res = await call({ ...CREDS, [field]: undefined });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(field);
    },
  );

  it("checks the config before the credentials, so the first fix named is the first one needed", async () => {
    const res = await call({});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("finish cloud setup");
  });
});
