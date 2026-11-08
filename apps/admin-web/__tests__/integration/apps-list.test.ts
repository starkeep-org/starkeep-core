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
  makeAppDir(parentA, "some-dir-name", testAppManifest({ id: "renamed-app" }));
  // Manifest without an id falls back to the directory name.
  const { id: _drop, ...idless } = testAppManifest();
  makeAppDir(parentA, "idless-app", idless);
  // Same manifest id in both parents — the first parent dir wins.
  makeAppDir(parentA, "dup-from-a", testAppManifest({ id: "dup-app", name: "From A" }));
  makeAppDir(parentB, "dup-from-b", testAppManifest({ id: "dup-app", name: "From B" }));

  makeAppDir(dataDir, "direct", testAppManifest({ id: "direct-app" }));

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
  dirs: Array<{ dir: string; appCount: number }>;
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

  it("skips a malformed manifest and reports the parse error", async () => {
    const { apps, problems } = await body();
    expect(apps.map((a) => a.appId)).not.toContain("broken");
    expect(apps.map((a) => a.sourceDir)).not.toContain(join(parentA, "broken"));
    const broken = problems.find((p) => p.dir === join(parentA, "broken"));
    expect(broken?.configuredDir).toBe(parentA);
    expect(broken?.reason).toMatch(/could not be read as JSON/);
  });

  it("treats a configured folder that holds a manifest as an app", async () => {
    const { apps, dirs } = await body();
    expect(apps.find((a) => a.appId === "direct-app")?.sourceDir).toBe(directApp);
    expect(dirs.find((d) => d.dir === directApp)?.appCount).toBe(1);
  });

  it("reports a configured folder that does not exist", async () => {
    const { problems, dirs } = await body();
    expect(problems.find((p) => p.dir === missingDir)?.reason).toBe("The folder does not exist.");
    expect(dirs.find((d) => d.dir === missingDir)?.appCount).toBe(0);
  });

  it("keys apps by manifest id, falling back to the dir name when id is missing", async () => {
    const apps = await list();
    const ids = apps.map((a) => a.appId);
    expect(ids).toContain("renamed-app");
    expect(ids).not.toContain("some-dir-name");
    expect(ids).toContain("idless-app");
  });

  it("de-dupes a manifest id present in two parent dirs — first parent wins", async () => {
    const apps = await list();
    const dups = apps.filter((a) => a.appId === "dup-app");
    expect(dups).toHaveLength(1);
    expect(dups[0]!.sourceDir).toBe(join(parentA, "dup-from-a"));
    expect(dups[0]!.manifest.name).toBe("From A");
    const { problems } = await body();
    expect(problems.find((p) => p.dir === join(parentB, "dup-from-b"))?.reason).toBe(
      `Another app already uses the id "dup-app", in ${join(parentA, "dup-from-a")}.`,
    );
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
