/**
 * Uninstall and node-local removal against a real cloud channel.
 *
 * `admin-apps.test.ts` asserts what each removal does to one node's database
 * and object store. This file asserts the half that needs a second party: that
 * a node-local removal is invisible to the cloud, and that the node it removed
 * from refills when the app is installed there again. Neither claim can be made
 * against a node with nowhere to sync to, and both are the reason the removal
 * clears the app's sync watermark.
 *
 * These are the repeatable form of verification steps 1 and 3 of
 * `implementation-status-rendition-ownership-phase-1-2026-09-17.md` §5. The
 * live runs in that section are the same sequence against a real cloud and a
 * real app; what is asserted here is the platform behavior underneath them, so
 * a regression surfaces without an AWS account and a Cognito login.
 *
 * One fake cloud, one node. Convergence is driven with explicit `/sync/now`
 * rounds rather than the tick, in the manner `sync-over-wire.test.ts`
 * established and for the reason its `converge()` comment gives.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  startLocalDataServer,
  startFakeCloud,
  fakeIdToken,
  type LocalDataServer,
  type FakeCloud,
} from "@starkeep/testkit";
import {
  builtinAppCreds,
  installApp,
  putAppFile,
  testAppManifest,
  eventually,
  type InstalledApp,
} from "./helpers.js";

let cloud: FakeCloud;
let server: LocalDataServer;
let drive: InstalledApp;

const manifest = testAppManifest({ id: "rejoin-app" });
const APP_ID = "rejoin-app";
/** The app's SQLite table prefix — `<appId>_syncable_`, with dashes mangled. */
const TABLE_PREFIX = "rejoin_app_syncable_";

/** One round on both channels, until two consecutive rounds report nothing. */
async function converge(app: InstalledApp, maxRounds = 30): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < maxRounds; i++) {
    const rounds = await Promise.all(
      [drive, app].map(async (who) => {
        const res = await who.fetch("/sync/now", { method: "POST" });
        expect(res.status).toBe(200);
        return (await res.json()) as { applied: number; shipped: number };
      }),
    );
    if (rounds.some((r) => r.applied !== 0 || r.shipped !== 0)) {
      quiet = 0;
      continue;
    }
    quiet += 1;
    if (quiet >= 2) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`did not converge within ${maxRounds} rounds`);
}

async function noteIds(app: InstalledApp): Promise<string[]> {
  const res = await app.fetch("/app-data/db/notes");
  expect(res.status).toBe(200);
  const { rows } = (await res.json()) as { rows: Array<{ note_id: string }> };
  return rows.map((r) => r.note_id).sort();
}

async function writeNote(app: InstalledApp, noteId: string, body: string): Promise<void> {
  const res = await app.fetch("/app-data/db/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ row: { note_id: noteId, body } }),
  });
  expect(res.status).toBe(200);
}

/** Bytes of an app-private file through its presigned GET, or null on 404. */
async function appFileBytes(app: InstalledApp, subKey: string): Promise<string | null> {
  const res = await app.fetch(`/app-data/files/${subKey}`);
  if (res.status === 404) return null;
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const bytes = await fetch(url);
  expect(bytes.status).toBe(200);
  return bytes.text();
}

function localTables(prefix: string): string[] {
  const db = new DatabaseSync(join(server.starkeepDir, "data.db"), { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?")
        .all(`${prefix}%`) as Array<{ name: string }>
    ).map((r) => r.name);
  } finally {
    db.close();
  }
}

function syncStateKeys(appId: string): string[] {
  const db = new DatabaseSync(join(server.starkeepDir, "data.db"), { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT key FROM sync_state WHERE key LIKE ?")
        .all(`${appId}:%`) as Array<{ key: string }>
    ).map((r) => r.key);
  } finally {
    db.close();
  }
}

/** The cloud's copy of the app's rows — the counts a removal must not move. */
function cloudNoteIds(): string[] {
  return cloud
    .appRows(APP_ID, "notes")
    .map((r) => String(r["note_id"]))
    .sort();
}

beforeAll(async () => {
  cloud = await startFakeCloud();
  server = await startLocalDataServer({
    config: {
      apiGatewayUrl: cloud.url,
      // Effectively no tick: every exchange in this file is one the test asked
      // for, so a removal is never racing a round nobody wrote down.
      pullIntervalMs: 600_000,
      pushDebounceMs: 50,
    },
    auth: { idToken: fakeIdToken() },
  });
  drive = await builtinAppCreds(server, "starkeep-drive");
  cloud.installApp(manifest);
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await cloud?.close();
});

describe("uninstall keeps the app's data, and a reinstall adopts it", () => {
  let app: InstalledApp;

  beforeAll(async () => {
    app = await installApp(server, manifest);
    await writeNote(app, "kept-1", "first");
    await writeNote(app, "kept-2", "second");
    await putAppFile(app, "private/blob.bin", "app private bytes");
    await converge(app);
  }, 30_000);

  it("the rows reached the cloud before anything was removed", async () => {
    expect(cloudNoteIds()).toEqual(["kept-1", "kept-2"]);
  });

  it("an uninstall leaves the tables and the app-private files where they are", async () => {
    const res = await fetch(`${server.url}/admin/apps/${APP_ID}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    // Gone as an app: the registry row and the HMAC identity both go.
    const list = await fetch(`${server.url}/admin/apps`);
    const { apps } = (await list.json()) as { apps: Array<{ appId: string }> };
    expect(apps.some((a) => a.appId === APP_ID)).toBe(false);
    expect((await app.fetch("/data/types")).status).toBe(401);

    // Not gone as data.
    expect(localTables(TABLE_PREFIX).length).toBeGreaterThan(0);
    await expect(
      stat(join(server.starkeepDir, "objects", "apps", APP_ID)),
    ).resolves.toBeDefined();
  }, 15_000);

  it("a reinstall reads back the rows the uninstall left behind", async () => {
    const again = await installApp(server, manifest);
    expect(await noteIds(again)).toEqual(["kept-1", "kept-2"]);
    expect(await appFileBytes(again, "private/blob.bin")).toBe("app private bytes");
    app = again;
  }, 30_000);

  it("and the reinstalled app still syncs, without re-shipping what it kept", async () => {
    await writeNote(app, "kept-3", "after the reinstall");
    await converge(app);
    expect(cloudNoteIds()).toEqual(["kept-1", "kept-2", "kept-3"]);
  }, 30_000);
});

describe("removing this node's copy reaches no peer, and the node refills", () => {
  let app: InstalledApp;
  let cloudBefore: string[];

  beforeAll(async () => {
    // Continues the previous block's app rather than standing up a second one:
    // the state a node-local removal is interesting against is a node that has
    // already synced, and that is exactly the state the block above leaves.
    app = await installApp(server, manifest);
    await converge(app);
    cloudBefore = cloudNoteIds();
    expect(cloudBefore.length).toBeGreaterThan(0);
  }, 30_000);

  it("the node has a sync position to lose", () => {
    expect(syncStateKeys(APP_ID).length).toBeGreaterThan(0);
  });

  it("drops this node's tables, files and watermark", async () => {
    const res = await fetch(`${server.url}/admin/apps/${APP_ID}/node-copy`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    expect(localTables(TABLE_PREFIX)).toEqual([]);
    expect(syncStateKeys(APP_ID)).toEqual([]);
    // The whole `apps/<id>/` subtree, not only `apps/<id>/syncable/`. Deletion
    // is asynchronous, so this polls rather than reading once.
    await eventually(async () => {
      await expect(
        stat(join(server.starkeepDir, "objects", "apps", APP_ID)),
      ).rejects.toThrow();
    });
  }, 15_000);

  it("and the cloud does not notice", () => {
    // The assertion the whole operation turns on. Dropping a syncable table
    // writes no tombstone, so nothing about a node-local removal is shipped —
    // every other node, and the cloud, keeps the app and its rows.
    expect(cloudNoteIds()).toEqual(cloudBefore);
  });

  it("installing the app here again refills it from the cloud", async () => {
    const again = await installApp(server, manifest);
    // Empty at first: the removal took the rows, and nothing has run yet.
    expect(await noteIds(again)).toEqual([]);

    await converge(again);
    await eventually(async () => {
      expect(await noteIds(again)).toEqual(cloudBefore);
    });
  }, 60_000);

  it("a removal of an app this node does not have cleanly no-ops", async () => {
    const res = await fetch(`${server.url}/admin/apps/never-here/node-copy`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});
