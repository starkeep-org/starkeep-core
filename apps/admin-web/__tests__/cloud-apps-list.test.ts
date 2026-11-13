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
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("each row the dashboard reads", () => {
  const row = {
    app_id: "photos",
    version: "1.2.0",
    name: "Photos",
    installed_at: new Date("2026-11-01T00:00:00Z"),
    updated_at: new Date("2026-11-02T00:00:00Z"),
    web_app: true,
    mobile_app: null,
    manifest: JSON.stringify({ id: "photos", infraRequirements: { publicSharing: true } }),
    web_source_hash: null,
  };

  it("carries the manifest the last install deployed, parsed", async () => {
    const { registryApp } = await import("../src/routes/apps-cloud-list");
    expect(registryApp(row)).toEqual({
      appId: "photos",
      version: "1.2.0",
      name: "Photos",
      installedAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-02T00:00:00.000Z",
      webApp: true,
      mobileApp: false,
      manifest: { id: "photos", infraRequirements: { publicSharing: true } },
    });
  });

  it.each([
    ["a row that predates the column", null],
    ["text that does not parse", "{ not json"],
    ["text that is not an object", "42"],
  ])("carries no manifest for %s, so the dashboard asks", async (_case, manifest) => {
    const { registryApp } = await import("../src/routes/apps-cloud-list");
    expect(registryApp({ ...row, manifest }).manifest).toBeNull();
  });
});

// The update dialog offers the cloud install when it runs another manifest
// or, for a web app, other code than the app's folder holds now.
describe("whether a row is behind its app's folder", () => {
  const deployed = { id: "photos", version: "1.0.0", infraRequirements: { publicSharing: true } };
  const row: {
    manifest: string | null;
    web_app: boolean | null;
    web_source_hash: string | null;
  } = { manifest: JSON.stringify(deployed), web_app: true, web_source_hash: "abc" };

  async function behind(
    r: Partial<typeof row>,
    folder?: { manifest: Record<string, unknown>; source: string | null },
  ) {
    const { behindFolder } = await import("../src/routes/apps-cloud-list");
    return behindFolder({ ...row, ...r }, folder);
  }

  it("is current when the folder holds the deployed manifest and code, whatever the key order", async () => {
    const reordered = {
      infraRequirements: { publicSharing: true },
      version: "1.0.0",
      id: "photos",
    };
    expect(await behind({}, { manifest: reordered, source: "abc" })).toEqual({
      behind: false,
      codeBehind: false,
    });
  });

  it("is behind when the folder holds another manifest", async () => {
    expect(
      await behind({}, { manifest: { ...deployed, version: "1.1.0" }, source: "abc" }),
    ).toMatchObject({ behind: true });
  });

  it("is behind when the row predates the recorded manifest, since a redeploy records one", async () => {
    expect(await behind({ manifest: null }, { manifest: deployed, source: "abc" })).toMatchObject({
      behind: true,
    });
  });

  it.each([
    ["the folder holds other code", "def", "abc"],
    ["the row predates the recorded fingerprint", "abc", null],
  ])("has code behind when %s", async (_case, source, recorded) => {
    expect(await behind({ web_source_hash: recorded }, { manifest: deployed, source })).toEqual({
      behind: false,
      codeBehind: true,
    });
  });

  it("never has code behind without a web app, whose code the cloud does not run", async () => {
    expect(await behind({ web_app: false }, { manifest: deployed, source: "def" })).toEqual({
      behind: false,
      codeBehind: false,
    });
  });

  it("cannot tell the code for a folder without a fingerprint", async () => {
    expect(await behind({}, { manifest: deployed, source: null })).toEqual({
      behind: false,
      codeBehind: null,
    });
  });

  it("cannot tell anything when no folder holds a valid manifest for the app", async () => {
    expect(await behind({}, undefined)).toEqual({ behind: null, codeBehind: null });
  });

  // A deploy records the folder's fingerprint, and the list compares it with
  // the folder's fingerprint now. A folder with uncommitted and untracked
  // files must read as current right after its deploy, and stay current
  // when the person commits the same files.
  it("reads a dirty folder as current after its deploy, and after the commit that follows", async () => {
    const { sourceFingerprint } = await import("@starkeep/admin-installer/app-discovery");
    const root = mkdtempSync(join(tmpdir(), "cloud-list-dirty-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(root, "index.ts"), "1");
    git("add", ".");
    git("commit", "-qm", "first");
    writeFileSync(join(root, "index.ts"), "2");
    writeFileSync(join(root, ".env"), "LOCAL=1");

    const recorded = sourceFingerprint(root);
    expect(recorded).not.toBeNull();
    const now = () => ({ manifest: deployed, source: sourceFingerprint(root) });
    expect(await behind({ web_source_hash: recorded }, now())).toMatchObject({ codeBehind: false });

    git("add", ".");
    git("commit", "-qm", "second");
    expect(await behind({ web_source_hash: recorded }, now())).toMatchObject({ codeBehind: false });

    writeFileSync(join(root, "index.ts"), "3");
    expect(await behind({ web_source_hash: recorded }, now())).toMatchObject({ codeBehind: true });
  });
});
