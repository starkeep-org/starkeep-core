/**
 * GET /api/apps/list — discovery from configured parent dirs joined with the
 * local-data-server's install registry. (Plan §5, Tier 1.)
 *
 * Boot order matters: the first describe block runs with the LDS *down* (the
 * URL points at a pre-allocated but unbound port) to pin the unknown-status
 * fallback; the LDS is then started on that same port for the status-join
 * cases.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getFreePort, startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { makeDataDir, makeAppDir, testAppManifest, writeAdminConfig } from "../helpers";

type ListedApp = {
  appId: string;
  manifest: Record<string, unknown>;
  sourceDir: string;
  status: string;
};

let GET: () => Promise<Response>;
let lds: LocalDataServer | undefined;
let ldsPort: number;
let parentA: string;
let parentB: string;
let directApp: string;
let missingDir: string;

beforeAll(async () => {
  const dataDir = makeDataDir();
  parentA = join(dataDir, "parent-a");
  parentB = join(dataDir, "parent-b");
  mkdirSync(parentA, { recursive: true });
  mkdirSync(parentB, { recursive: true });
  // An app folder configured directly, as an author who picks their own app's
  // folder does, and a configured folder that does not exist.
  directApp = join(dataDir, "direct");
  missingDir = join(dataDir, "no-such-dir");
  writeAdminConfig(dataDir, { appParentDirs: [parentA, parentB, directApp, missingDir] });

  // Valid app in parent A.
  makeAppDir(parentA, "alpha", testAppManifest({ id: "alpha-app", name: "Alpha" }));
  // Malformed manifest — must be skipped, not break the scan.
  makeAppDir(parentA, "broken", "{ this is not json");
  // Manifest id wins over the directory name.
  makeAppDir(parentA, "some-dir-name", testAppManifest({ id: "renamed-app", name: "Renamed" }));
  // Same manifest id in both parents — the first parent dir wins.
  makeAppDir(parentA, "dup-from-a", testAppManifest({ id: "dup-app", name: "From A" }));
  makeAppDir(parentB, "dup-from-b", testAppManifest({ id: "dup-app", name: "From B" }));

  makeAppDir(dataDir, "direct", testAppManifest({ id: "direct-app", name: "Direct" }));

  ldsPort = await getFreePort();
  process.env.STARKEEP_DIR = dataDir;
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL = `http://127.0.0.1:${ldsPort}`;
  ({ GET } = await import("../../src/routes/apps-list"));
});

afterAll(async () => {
  await lds?.stop();
});

type ListBody = {
  apps: ListedApp[];
  problems: Array<{ configuredDir: string; dir: string; reason: string }>;
  dirs: Array<{
    dir: string;
    apps: Array<{ appId: string; name: string }>;
    problems: Array<{ configuredDir: string; dir: string; reason: string }>;
  }>;
};

async function body(): Promise<ListBody> {
  return (await (await GET()).json()) as ListBody;
}

async function list(): Promise<ListedApp[]> {
  const res = await GET();
  expect(res.status).toBe(200);
  const { apps } = (await res.json()) as { apps: ListedApp[] };
  return apps;
}

describe("with the local-data-server down", () => {
  it("reports every discovered app as unknown, not not_installed", async () => {
    const apps = await list();
    expect(apps.length).toBeGreaterThan(0);
    for (const app of apps) expect(app.status).toBe("unknown");
    expect(apps.map((a) => a.appId)).toContain("alpha-app");
  });

  it("reports the registry as unreadable", async () => {
    const res = await GET();
    const body = (await res.json()) as { dataServerReachable: boolean };
    expect(body.dataServerReachable).toBe(false);
  });

  it("groups apps and problems under the configured folder they came from", async () => {
    const { dirs } = await body();
    expect(dirs.map((d) => d.dir)).toEqual([parentA, parentB, directApp, missingDir]);

    const a = dirs.find((d) => d.dir === parentA)!;
    expect(a.apps).toEqual([
      { appId: "alpha-app", name: "Alpha" },
      { appId: "dup-app", name: "From A" },
      { appId: "renamed-app", name: "Renamed" },
    ]);
    expect(a.problems).toEqual([
      {
        configuredDir: parentA,
        dir: join(parentA, "broken"),
        reason: expect.stringMatching(/^Invalid manifest found for broken: /),
      },
    ]);

    const b = dirs.find((d) => d.dir === parentB)!;
    expect(b.apps).toEqual([]);
    expect(b.problems.map((p) => p.reason)).toEqual([
      `dup-from-b uses the app id "dup-app", which ${join(parentA, "dup-from-a")} already uses.`,
    ]);

    expect(dirs.find((d) => d.dir === directApp)).toEqual({
      dir: directApp,
      apps: [{ appId: "direct-app", name: "Direct" }],
      problems: [],
    });
    expect(dirs.find((d) => d.dir === missingDir)?.problems.map((p) => p.reason)).toEqual([
      "The folder does not exist.",
    ]);
  });

  it("lists every problem flat as well, and cards only valid apps", async () => {
    const { apps, problems } = await body();
    expect(problems).toHaveLength(3);
    expect(apps.map((a) => a.appId).sort()).toEqual([
      "alpha-app",
      "direct-app",
      "dup-app",
      "renamed-app",
    ]);
    expect(apps.find((a) => a.appId === "dup-app")?.sourceDir).toBe(join(parentA, "dup-from-a"));
    expect(apps.find((a) => a.appId === "direct-app")?.sourceDir).toBe(directApp);
  });
});

describe("with the local-data-server up", () => {
  beforeAll(async () => {
    lds = await startLocalDataServer({ port: ldsPort });
    // Install alpha-app directly on the LDS; the list route should join it.
    const res = await fetch(`${lds.url}/admin/apps/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testAppManifest({ id: "alpha-app", name: "Alpha" })),
    });
    expect(res.ok).toBe(true);
  });

  it("joins install status from the registry; others stay not_installed", async () => {
    const apps = await list();
    expect(apps.find((a) => a.appId === "alpha-app")?.status).toBe("active");
    expect(apps.find((a) => a.appId === "renamed-app")?.status).toBe("not_installed");
  });

  it("reports the registry as readable", async () => {
    const res = await GET();
    const body = (await res.json()) as { dataServerReachable: boolean };
    expect(body.dataServerReachable).toBe(true);
  });

  it("does not surface registry-only apps (built-ins) that have no manifest on disk", async () => {
    const apps = await list();
    expect(apps.map((a) => a.appId)).not.toContain("starkeep-drive");
    expect(apps.map((a) => a.appId)).not.toContain("local-watcher");
  });
});
