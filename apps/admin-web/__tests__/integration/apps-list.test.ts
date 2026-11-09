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
import { mkdirSync, rmSync } from "node:fs";
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
      { appId: "renamed-app", name: "Renamed" },
    ]);
    expect(a.problems).toEqual([
      {
        configuredDir: parentA,
        dir: join(parentA, "broken"),
        reason: expect.stringMatching(/^Invalid manifest found for broken: /),
      },
      {
        configuredDir: parentA,
        dir: join(parentA, "dup-from-a"),
        reason: `dup-from-a uses the app id "dup-app", which ${join(parentB, "dup-from-b")} also uses.`,
      },
    ]);

    const b = dirs.find((d) => d.dir === parentB)!;
    expect(b.apps).toEqual([]);
    expect(b.problems.map((p) => p.reason)).toEqual([
      `dup-from-b uses the app id "dup-app", which ${join(parentA, "dup-from-a")} also uses.`,
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

  it("lists every problem flat as well, and cards only valid apps with one folder each", async () => {
    const { apps, problems } = await body();
    expect(problems).toHaveLength(4);
    // Two folders hold dup-app, so neither gets a card: folder order picks no winner.
    expect(apps.map((a) => a.appId).sort()).toEqual(["alpha-app", "direct-app", "renamed-app"]);
    expect(apps.find((a) => a.appId === "direct-app")?.sourceDir).toBe(directApp);
  });
});

describe("with the local-data-server up", () => {
  let pinnedHome: string;
  let goneDir: string;
  let changingDir: string;
  let invalidDir: string;

  async function installOnLds(manifest: Record<string, unknown>, sourceDir?: string) {
    const res = await fetch(`${lds!.url}/admin/apps/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest, ...(sourceDir ? { sourceDir } : {}) }),
    });
    expect(res.ok).toBe(true);
  }

  beforeAll(async () => {
    lds = await startLocalDataServer({ port: ldsPort });
    const dataDir = process.env.STARKEEP_DIR!;

    // Installed from its scanned folder.
    await installOnLds(testAppManifest({ id: "alpha-app", name: "Alpha" }), join(parentA, "alpha"));

    // Installed from a folder no configured entry reaches, with a second copy
    // in a configured folder.
    pinnedHome = makeAppDir(
      join(dataDir, "elsewhere"),
      "pinned",
      testAppManifest({ id: "pinned-app", name: "Pinned" }),
    );
    makeAppDir(parentB, "pinned-copy", testAppManifest({ id: "pinned-app", name: "Copy" }));
    await installOnLds(testAppManifest({ id: "pinned-app", name: "Pinned" }), pinnedHome);

    // Installed from a folder that is then deleted.
    goneDir = makeAppDir(dataDir, "gone", testAppManifest({ id: "gone-app", name: "Gone" }));
    await installOnLds(testAppManifest({ id: "gone-app", name: "Gone" }), goneDir);
    rmSync(goneDir, { recursive: true });

    // Installed, then its folder's manifest changes.
    changingDir = makeAppDir(
      parentA,
      "changing",
      testAppManifest({ id: "changing-app", name: "Changing" }),
    );
    await installOnLds(testAppManifest({ id: "changing-app", name: "Changing" }), changingDir);
    makeAppDir(
      parentA,
      "changing",
      testAppManifest({ id: "changing-app", name: "Changing", version: "2.0.0" }),
    );

    // Installed, then its folder's manifest stops validating.
    invalidDir = makeAppDir(
      dataDir,
      "invalid",
      testAppManifest({ id: "invalid-app", name: "Invalid" }),
    );
    await installOnLds(testAppManifest({ id: "invalid-app", name: "Invalid" }), invalidDir);
    makeAppDir(dataDir, "invalid", {
      ...testAppManifest({ id: "invalid-app", name: "Invalid", version: "2.0.0" }),
      name: undefined,
    });

    // Installed before the registry pinned folders: no sourceDir.
    makeAppDir(parentA, "legacy", testAppManifest({ id: "legacy-app", name: "Legacy" }));
    await installOnLds(testAppManifest({ id: "legacy-app", name: "Legacy" }));
  });

  it("joins install status from the registry; others stay not_installed", async () => {
    const apps = await list();
    expect(apps.find((a) => a.appId === "alpha-app")?.status).toBe("active");
    expect(apps.find((a) => a.appId === "renamed-app")?.status).toBe("not_installed");
  });

  it("cards an installed app from its pinned folder, with no source state while it is unchanged", async () => {
    const alpha = (await list()).find((a) => a.appId === "alpha-app");
    expect(alpha).toMatchObject({ sourceDir: join(parentA, "alpha"), configuredDir: parentA });
    expect(alpha).not.toHaveProperty("sourceState");
  });

  it("keeps an installed app whose pin no configured folder reaches, and reports the other copy", async () => {
    const { apps, dirs } = await body();
    const pinned = apps.filter((a) => a.appId === "pinned-app");
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatchObject({ sourceDir: pinnedHome, status: "active" });
    expect(pinned[0]).not.toHaveProperty("configuredDir");
    expect((pinned[0]!.manifest as { name: string }).name).toBe("Pinned");
    expect(dirs.find((d) => d.dir === parentB)!.problems.map((p) => p.reason)).toContain(
      `pinned-copy uses the app id "pinned-app", which is already installed from ${pinnedHome}.`,
    );
  });

  it("marks an installed app whose pinned folder is gone, rather than dropping it", async () => {
    const gone = (await list()).find((a) => a.appId === "gone-app");
    expect(gone).toMatchObject({ sourceDir: goneDir, sourceState: "missing", status: "active" });
  });

  it("marks an installed app whose folder now holds a different manifest, and keeps the approved one", async () => {
    const changing = (await list()).find((a) => a.appId === "changing-app");
    expect(changing).toMatchObject({ sourceDir: changingDir, sourceState: "changed" });
    expect((changing!.manifest as { version: string }).version).toBe("1.0.0");
    expect((changing as { folderManifest?: { version: string } }).folderManifest?.version).toBe(
      "2.0.0",
    );
  });

  it("keeps an installed app whose folder's manifest fails validation, with the error and the approved manifest", async () => {
    const invalid = (await list()).find((a) => a.appId === "invalid-app");
    expect(invalid).toMatchObject({
      sourceDir: invalidDir,
      sourceState: "invalid",
      sourceError: expect.stringMatching(/^name: /),
      status: "active",
    });
    expect((invalid!.manifest as { version: string }).version).toBe("1.0.0");
    expect(invalid).not.toHaveProperty("folderManifest");
  });

  it("resolves an installed app with no pinned folder through the scan", async () => {
    const legacy = (await list()).find((a) => a.appId === "legacy-app");
    expect(legacy).toMatchObject({
      sourceDir: join(parentA, "legacy"),
      configuredDir: parentA,
      status: "active",
    });
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
