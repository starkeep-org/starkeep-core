/**
 * POST /api/apps/uninstall — stop the daemon first, delete the local secret,
 * forward the DELETE to the local-data-server. (Plan §5, Tier 1.)
 */
import { it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest, NextResponse } from "next/server";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  eventually,
  isAlive,
  jsonRequest,
  makeDataDir,
  spawnIdleProcess,
  testAppManifest,
} from "./helpers";

let POST: (req: NextRequest) => Promise<NextResponse>;
let lds: LocalDataServer;
let dataDir: string;
let credsDir: string;
let pidsDir: string;

beforeAll(async () => {
  dataDir = makeDataDir();
  credsDir = join(dataDir, "app-creds");
  pidsDir = join(dataDir, "pids");

  lds = await startLocalDataServer();
  process.env.STARKEEP_DATA_DIR = dataDir;
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL = lds.url;
  ({ POST } = await import("../app/api/apps/uninstall/route"));

  // Install directly on the LDS and lay down the secret file the way the
  // install route would.
  const res = await fetch(`${lds.url}/admin/apps/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(testAppManifest({ id: "doomed-app" })),
  });
  expect(res.ok).toBe(true);
  const { appId, hmacSecret } = (await res.json()) as { appId: string; hmacSecret: string };
  mkdirSync(credsDir, { recursive: true });
  writeFileSync(
    join(credsDir, "doomed-app.json"),
    JSON.stringify({ appId, hmacSecret, dataServerUrl: lds.url }),
    { mode: 0o600 },
  );
});

afterAll(async () => {
  await lds.stop();
});

const uninstall = (body: unknown) => POST(jsonRequest("/api/apps/uninstall", body));

it("rejects a missing appId with 400", async () => {
  const res = await uninstall({});
  expect(res.status).toBe(400);
});

it("stops the running daemon, deletes the secret, and removes the registry row", async () => {
  const child = spawnIdleProcess();
  mkdirSync(pidsDir, { recursive: true });
  writeFileSync(join(pidsDir, "doomed-app.pid"), String(child.pid));
  const secretPath = join(credsDir, "doomed-app.json");
  expect(existsSync(secretPath)).toBe(true);

  const res = await uninstall({ appId: "doomed-app" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

  await eventually(() => {
    expect(isAlive(child.pid!)).toBe(false);
  });
  expect(existsSync(join(pidsDir, "doomed-app.pid"))).toBe(false);
  expect(existsSync(secretPath)).toBe(false);

  const listRes = await fetch(`${lds.url}/admin/apps`);
  const { apps } = (await listRes.json()) as { apps: Array<{ appId: string; status: string }> };
  const row = apps.find((a) => a.appId === "doomed-app");
  // The LDS may keep an uninstalled tombstone row; it must not stay active.
  if (row) expect(row.status).not.toBe("active");
});

it("returns 502 when the local-data-server is unreachable", async () => {
  await lds.stop();
  const res = await uninstall({ appId: "doomed-app" });
  expect(res.status).toBe(502);
});
