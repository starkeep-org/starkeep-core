/**
 * POST /api/apps/install — the user-consent gate and per-app secret
 * persistence. (Plan §5, Tier 1.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  eventually,
  isAlive,
  jsonRequest,
  makeAppDir,
  makeDataDir,
  spawnIdleProcess,
  testAppManifest,
  writeAdminConfig,
} from "../helpers";

let POST: (req: Request) => Promise<Response>;
let lds: LocalDataServer;
let dataDir: string;
let credsDir: string;
let pidsDir: string;

beforeAll(async () => {
  dataDir = makeDataDir();
  credsDir = join(dataDir, "app-creds");
  pidsDir = join(dataDir, "pids");
  const parent = join(dataDir, "apps");
  mkdirSync(parent, { recursive: true });
  writeAdminConfig(dataDir, { appParentDirs: [parent] });
  makeAppDir(parent, "inst", testAppManifest({ id: "inst-app", name: "Installable" }));
  // Valid JSON that fails the manifest validator (no name/version/tier).
  makeAppDir(parent, "invalid", { id: "invalid-app" });

  lds = await startLocalDataServer();
  process.env.STARKEEP_DIR = dataDir;
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL = lds.url;
  POST = (await import("../../src/routes/apps-install")).POST;
});

afterAll(async () => {
  await lds.stop();
});

const install = (body: unknown) => POST(jsonRequest("/api/apps/install", body));

describe("approval gate", () => {
  it("rejects a missing appId with 400", async () => {
    const res = await install({ approved: true });
    expect(res.status).toBe(400);
  });

  it("rejects approved=false and missing approved with 400, and writes no secret", async () => {
    for (const body of [{ appId: "inst-app" }, { appId: "inst-app", approved: false }]) {
      const res = await install(body);
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toMatch(/approval/i);
    }
    expect(existsSync(join(credsDir, "inst-app.json"))).toBe(false);
  });

  it("returns 404 for an appId not present in any parent dir", async () => {
    const res = await install({ appId: "ghost-app", approved: true });
    expect(res.status).toBe(404);
  });
});

describe("successful install", () => {
  it("registers on the LDS and writes the secret file with mode 0600", async () => {
    const res = await install({ appId: "inst-app", approved: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appId: string; secretPath: string; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.appId).toBe("inst-app");

    const secretPath = join(credsDir, "inst-app.json");
    expect(body.secretPath).toBe(secretPath);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    const creds = JSON.parse(readFileSync(secretPath, "utf-8")) as Record<string, string>;
    expect(creds.appId).toBe("inst-app");
    expect(creds.hmacSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(creds.dataServerUrl).toBe(lds.url);

    const listRes = await fetch(`${lds.url}/admin/apps`);
    const { apps } = (await listRes.json()) as {
      apps: Array<{ appId: string; status: string; sourceDir: string | null }>;
    };
    expect(apps.find((a) => a.appId === "inst-app")).toMatchObject({
      status: "active",
      // Install pins the folder the manifest came from.
      sourceDir: join(dataDir, "apps", "inst"),
    });
  });

  it("reinstalls from the pinned folder, not another folder the scan finds", async () => {
    // A second copy with the same id appears in a newly configured folder.
    const other = join(dataDir, "other-apps");
    makeAppDir(other, "inst-copy", testAppManifest({ id: "inst-app", name: "Copy" }));
    writeAdminConfig(dataDir, { appParentDirs: [other, join(dataDir, "apps")] });
    try {
      const res = await install({ appId: "inst-app", approved: true });
      expect(res.status).toBe(200);
      const { apps } = (await (await fetch(`${lds.url}/admin/apps`)).json()) as {
        apps: Array<{ appId: string; name: string; sourceDir: string | null }>;
      };
      expect(apps.find((a) => a.appId === "inst-app")).toMatchObject({
        name: "Installable",
        sourceDir: join(dataDir, "apps", "inst"),
      });
    } finally {
      writeAdminConfig(dataDir, { appParentDirs: [join(dataDir, "apps")] });
    }
  });

  it("reinstall keeps the same secret and re-tightens loosened file perms to 0600", async () => {
    const secretPath = join(credsDir, "inst-app.json");
    const before = JSON.parse(readFileSync(secretPath, "utf-8")) as { hmacSecret: string };
    chmodSync(secretPath, 0o644);

    const res = await install({ appId: "inst-app", approved: true });
    expect(res.status).toBe(200);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    const after = JSON.parse(readFileSync(secretPath, "utf-8")) as { hmacSecret: string };
    expect(after.hmacSecret).toBe(before.hmacSecret);
  });

  it("stops a running app daemon so it restarts with the fresh secret", async () => {
    // Stand-in for a daemon admin-web started earlier: a detached process
    // whose pid is recorded in pids/<appId>.pid.
    const child = spawnIdleProcess();
    mkdirSync(pidsDir, { recursive: true });
    const pidPath = join(pidsDir, "inst-app.pid");
    writeFileSync(pidPath, String(child.pid));

    const res = await install({ appId: "inst-app", approved: true });
    expect(res.status).toBe(200);
    await eventually(() => {
      expect(isAlive(child.pid!)).toBe(false);
    });
    expect(existsSync(pidPath)).toBe(false);
  });
});

describe("local-data-server error paths", () => {
  it("refuses an app whose manifest fails validation, because the scan never offers it", async () => {
    // The scan runs the validator Install runs, so Discover apps reports the
    // manifest and the Dashboard shows no card to install.
    const res = await install({ appId: "invalid-app", approved: true });
    expect(res.status).toBe(404);
  });

  it("returns 502 when the local-data-server is unreachable", async () => {
    await lds.stop();
    const res = await install({ appId: "inst-app", approved: true });
    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/local-data-server/);
  });
});
