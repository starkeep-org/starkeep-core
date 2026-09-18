/**
 * Install/uninstall lifecycle via /admin/apps, plus the built-in registry
 * state on a fresh boot. (Plan §3 "Install/uninstall lifecycle" + §6.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  installApp,
  putAppFile,
  testAppManifest,
  createRecordWithBytes,
  type InstalledApp,
} from "./helpers.js";

let server: LocalDataServer;

beforeAll(async () => {
  server = await startLocalDataServer();
}, 60_000);

afterAll(async () => {
  await server.stop();
});

function registryTableNames(): string[] {
  const db = new DatabaseSync(join(server.starkeepDir, "data.db"), { readOnly: true });
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
  } finally {
    db.close();
  }
}

describe("built-ins on a fresh boot", () => {
  it("registers starkeep-drive and local-watcher in the registry", async () => {
    const res = await fetch(`${server.url}/admin/apps`);
    const { apps } = (await res.json()) as {
      apps: Array<{ appId: string; status: string; fileAccessAll: boolean }>;
    };
    const drive = apps.find((a) => a.appId === "starkeep-drive");
    const watcher = apps.find((a) => a.appId === "local-watcher");
    expect(drive).toBeDefined();
    expect(drive!.status).toBe("active");
    expect(drive!.fileAccessAll).toBe(true);
    expect(watcher).toBeDefined();
    expect(watcher!.status).toBe("active");
    expect(watcher!.fileAccessAll).toBe(false);
  });
});

describe("install", () => {
  it("returns {appId, hmacSecret}; the secret never appears in GET /admin/apps", async () => {
    const app = await installApp(server, testAppManifest({ id: "lifecycle-app" }));
    expect(app.appId).toBe("lifecycle-app");
    expect(app.hmacSecret).toMatch(/^[0-9a-f]{64}$/);

    const listRes = await fetch(`${server.url}/admin/apps`);
    const text = await listRes.text();
    expect(text).toContain("lifecycle-app");
    expect(text).not.toContain(app.hmacSecret);
    const { apps } = JSON.parse(text) as { apps: Array<Record<string, unknown>> };
    for (const row of apps) {
      expect(Object.keys(row)).not.toContain("hmacSecret");
      expect(Object.keys(row)).not.toContain("hmac_secret");
    }
  });

  it("re-install of an active app is a no-op returning the same secret", async () => {
    const first = await installApp(server, testAppManifest({ id: "reinstall-app" }));
    const second = await installApp(server, testAppManifest({ id: "reinstall-app" }));
    expect(second.hmacSecret).toBe(first.hmacSecret);
  });

  it("rejects an invalid manifest with the validator's errors", async () => {
    const res = await fetch(`${server.url}/admin/apps/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bad-app", infraRequirements: { fileAccessAll: true } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: string[] };
    expect(body.error).toBe("ManifestValidationError");
    expect(body.details.length).toBeGreaterThan(0);
  });

  it("records the step ledger, readable via /admin/apps/:id/install-steps", async () => {
    await installApp(server, testAppManifest({ id: "stepped-app" }));
    const res = await fetch(`${server.url}/admin/apps/stepped-app/install-steps`);
    expect(res.status).toBe(200);
    const { steps } = (await res.json()) as {
      steps: Array<{ step: string; status: string; operation: string }>;
    };
    const doneSteps = steps
      .filter((s) => s.status === "done" && s.operation === "install")
      .map((s) => s.step)
      .sort();
    expect(doneSteps).toEqual(
      [
        "create_app_registry_row",
        "create_access_grants",
        "register_label_keys",
        "create_syncable_tables",
        "register_syncable_namespace",
        "mark_active",
      ].sort(),
    );
  });
});

describe("uninstall", () => {
  let app: InstalledApp;
  let sharedRecordId: string;

  beforeAll(async () => {
    app = await installApp(server, testAppManifest({ id: "doomed-app" }));
    const created = await createRecordWithBytes(app, { fileName: "survivor.jpg" });
    sharedRecordId = created.record.id;
    // Leave app-specific data behind too.
    await app.fetch("/app-data/db/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { note_id: "doomed", body: "bye" } }),
    });
    await putAppFile(app, "keep/me.bin", "app private bytes");
  });

  it("deleteData drops tables, grants, namespace and the files prefix — shared records survive", async () => {
    const before = registryTableNames();
    expect(before).toContain("doomed_app_syncable_notes");

    const res = await fetch(`${server.url}/admin/apps/doomed-app?deleteData=1`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { deleteData: boolean }).toMatchObject({ deleteData: true });

    // Registry row gone.
    const list = await fetch(`${server.url}/admin/apps`);
    const { apps } = (await list.json()) as { apps: Array<{ appId: string }> };
    expect(apps.some((a) => a.appId === "doomed-app")).toBe(false);

    // App tables gone.
    const after = registryTableNames();
    expect(after.some((n) => n.startsWith("doomed_app_syncable_"))).toBe(false);

    // The app's HMAC identity is revoked.
    const denied = await app.fetch("/data/types");
    expect(denied.status).toBe(401);

    // Syncable files prefix removed from object storage (async deletion —
    // poll). The uninstall contract targets apps/<id>/syncable/, not the
    // whole apps/<id>/ subtree.
    const prefixPath = join(server.starkeepDir, "objects", "apps", "doomed-app", "syncable");
    const deadline = Date.now() + 5_000;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        await stat(prefixPath);
      } catch {
        gone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(gone).toBe(true);

    // Shared record survives, visible to an all-access identity.
    const db = new DatabaseSync(join(server.starkeepDir, "data.db"), { readOnly: true });
    try {
      const row = db
        .prepare("SELECT id, deleted_at FROM shared_records WHERE id = ?")
        .get(sharedRecordId) as { id: string; deleted_at: string | null } | undefined;
      expect(row).toBeDefined();
      expect(row!.deleted_at).toBeNull();
    } finally {
      db.close();
    }
  }, 15_000);

  it("uninstall of a never-installed app cleanly no-ops", async () => {
    const res = await fetch(`${server.url}/admin/apps/never-was?deleteData=1`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("reinstall after uninstall mints a fresh secret and a clean ledger", async () => {
    const again = await installApp(server, testAppManifest({ id: "doomed-app" }));
    expect(again.hmacSecret).not.toBe(app.hmacSecret);
    const ok = await again.fetch("/data/types");
    expect(ok.status).toBe(200);
    // Cleanup for other files' sake — `deleteData`, or the tables this test
    // created outlive it.
    await fetch(`${server.url}/admin/apps/doomed-app?deleteData=1`, { method: "DELETE" });
  });
});

/** Poll until `path` no longer exists, or give up. Object deletion is async. */
async function waitGone(path: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function appTableNames(prefix: string): string[] {
  return registryTableNames().filter((n) => n.startsWith(prefix));
}

function syncStateKeys(appId: string): string[] {
  const db = new DatabaseSync(join(server.starkeepDir, "data.db"), { readOnly: true });
  try {
    if (
      (db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'")
        .all() as unknown[]).length === 0
    ) {
      return [];
    }
    return (
      db
        .prepare("SELECT key FROM sync_state WHERE key LIKE ?")
        .all(`${appId}:%`) as Array<{ key: string }>
    ).map((r) => r.key);
  } finally {
    db.close();
  }
}

function writeSyncStateKey(appId: string, suffix: string, value: string): void {
  const db = new DatabaseSync(join(server.starkeepDir, "data.db"));
  try {
    // `createSqliteSyncStateStore` makes this table, and it only runs on a node
    // configured with a cloud. This server has none, so the test stands the
    // table up itself with the same shape.
    db.exec(
      "CREATE TABLE IF NOT EXISTS sync_state (key text PRIMARY KEY, value_json text NOT NULL, " +
        "updated_at integer NOT NULL DEFAULT (strftime('%s','now')))",
    );
    db.prepare(
      "INSERT INTO sync_state (key, value_json, updated_at) VALUES (?, ?, strftime('%s','now')) " +
        "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
    ).run(`${appId}:${suffix}`, value);
  } finally {
    db.close();
  }
}

describe("uninstall keeps the app's data by default", () => {
  let app: InstalledApp;

  beforeAll(async () => {
    app = await installApp(server, testAppManifest({ id: "kept-app" }));
    await app.fetch("/app-data/db/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { note_id: "kept", body: "still here" } }),
    });
    await putAppFile(app, "keep/me.bin", "app private bytes");
  });

  it("keeps the app's tables and private files while removing the app", async () => {
    expect(appTableNames("kept_app_syncable_").length).toBeGreaterThan(0);

    // No query parameter. Keeping the data is what a caller who said nothing
    // gets, which is the half of this contract most worth pinning: a proxy
    // that drops the flag, or a caller that forgets it, must not destroy data.
    const res = await fetch(`${server.url}/admin/apps/kept-app`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { deleteData: boolean }).toMatchObject({ deleteData: false });

    // The app is gone as an app.
    const list = await fetch(`${server.url}/admin/apps`);
    const { apps } = (await list.json()) as { apps: Array<{ appId: string }> };
    expect(apps.some((a) => a.appId === "kept-app")).toBe(false);
    expect((await app.fetch("/data/types")).status).toBe(401);

    // Its data is not.
    expect(appTableNames("kept_app_syncable_").length).toBeGreaterThan(0);
    // Deletion is asynchronous when it happens at all, so a prefix that is
    // still there after the window the destructive path is given is a prefix
    // nothing tried to delete.
    const prefixPath = join(server.starkeepDir, "objects", "apps", "kept-app");
    expect(await waitGone(prefixPath, 1_500)).toBe(false);
  }, 15_000);

  it("a reinstall finds the retained rows where the uninstall left them", async () => {
    const again = await installApp(server, testAppManifest({ id: "kept-app" }));
    const res = await again.fetch("/app-data/db/notes");
    expect(res.status).toBe(200);
    const { rows } = (await res.json()) as { rows: Array<{ note_id: string; body: string }> };
    expect(rows.find((r) => r.note_id === "kept")?.body).toBe("still here");
    await fetch(`${server.url}/admin/apps/kept-app?deleteData=1`, { method: "DELETE" });
  });
});

describe("remove from this node", () => {
  let app: InstalledApp;
  let sharedRecordId: string;

  beforeAll(async () => {
    app = await installApp(server, testAppManifest({ id: "local-only-app" }));
    const created = await createRecordWithBytes(app, { fileName: "shared.jpg" });
    sharedRecordId = created.record.id;
    await app.fetch("/app-data/db/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { note_id: "local", body: "on this node" } }),
    });
    await putAppFile(app, "keep/me.bin", "app private bytes");
    // The supervisor only writes these once an exchange has run, and this
    // server has no cloud to exchange with, so the watermarks are seeded
    // directly. What matters is that the removal deletes rows under the app's
    // key prefix and nothing else.
    writeSyncStateKey("local-only-app", "watermarks", JSON.stringify({ cloud: "1" }));
    writeSyncStateKey("local-only-app", "peer_watermarks", JSON.stringify({ cloud: "1" }));
    writeSyncStateKey("other-app", "watermarks", JSON.stringify({ cloud: "9" }));
  });

  it("drops the tables, the whole app prefix and the sync watermark", async () => {
    expect(syncStateKeys("local-only-app").length).toBe(2);

    const res = await fetch(`${server.url}/admin/apps/local-only-app/node-copy`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const list = await fetch(`${server.url}/admin/apps`);
    const { apps } = (await list.json()) as { apps: Array<{ appId: string }> };
    expect(apps.some((a) => a.appId === "local-only-app")).toBe(false);
    expect(appTableNames("local_only_app_syncable_")).toEqual([]);
    expect(syncStateKeys("local-only-app")).toEqual([]);
    // Another app's watermark is not collateral.
    expect(syncStateKeys("other-app")).toEqual(["other-app:watermarks"]);

    // The whole `apps/<id>/` subtree goes, not only `syncable/` — a node-local
    // removal is meant to reclaim everything the app put on this machine.
    const prefixPath = join(server.starkeepDir, "objects", "apps", "local-only-app");
    expect(await waitGone(prefixPath)).toBe(true);

    // Shared records are not this node's to remove, and are not removed.
    const db = new DatabaseSync(join(server.starkeepDir, "data.db"), { readOnly: true });
    try {
      const row = db
        .prepare("SELECT id, deleted_at FROM shared_records WHERE id = ?")
        .get(sharedRecordId) as { id: string; deleted_at: string | null } | undefined;
      expect(row).toBeDefined();
      expect(row!.deleted_at).toBeNull();
    } finally {
      db.close();
    }
  }, 15_000);

  it("removing an app this node never had cleanly no-ops", async () => {
    const res = await fetch(`${server.url}/admin/apps/never-was/node-copy`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});
