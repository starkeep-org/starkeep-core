/**
 * Install/uninstall lifecycle via /admin/apps, plus the built-in registry
 * state on a fresh boot. (Plan §3 "Install/uninstall lifecycle" + §6.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { PROTOCOL_VERSION, parseProtocolVersion } from "@starkeep/protocol-primitives";
import {
  installApp,
  putAppFile,
  testAppManifest,
  createRecordWithBytes,
  type InstalledApp,
} from "../helpers.js";

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
  it("reports its protocol version on /health and refuses an app that needs a newer one", async () => {
    const health = (await (await fetch(`${server.url}/health`)).json()) as {
      protocolVersion: string;
    };
    expect(health.protocolVersion).toBe(PROTOCOL_VERSION);

    const [major, minor] = parseProtocolVersion(PROTOCOL_VERSION)!;
    const res = await fetch(`${server.url}/admin/apps/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: {
          ...testAppManifest({ id: "future-app" }),
          protocolMinVersion: `${major}.${minor + 1}.0`,
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ProtocolVersionError");
    expect(body.message).toContain(`speaks ${PROTOCOL_VERSION}`);
  });

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

  it("lists each app with its approved manifest and its pinned folder", async () => {
    await installApp(server, testAppManifest({ id: "pinned-app", name: "Pinned" }), "/apps/pinned");
    const res = await fetch(`${server.url}/admin/apps`);
    const { apps } = (await res.json()) as {
      apps: Array<{ appId: string; manifest: { id: string; name: string }; sourceDir: unknown }>;
    };
    const pinned = apps.find((a) => a.appId === "pinned-app")!;
    expect(pinned.sourceDir).toBe("/apps/pinned");
    expect(pinned.manifest).toMatchObject({ id: "pinned-app", name: "Pinned" });
    // A built-in has no folder.
    expect(apps.find((a) => a.appId === "starkeep-drive")!.sourceDir).toBeNull();
  });

  it("refuses an install from a web page, and leaves the installed manifest alone", async () => {
    const manifest = testAppManifest({ id: "origin-app", name: "Approved" });
    await installApp(server, manifest, "/apps/origin-app");
    const res = await fetch(`${server.url}/admin/apps/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({
        manifest: { ...manifest, name: "Replaced", localRun: { command: "/bin/sh" } },
      }),
    });
    expect(res.status).toBe(403);

    const list = (await (await fetch(`${server.url}/admin/apps`)).json()) as {
      apps: Array<{ appId: string; manifest: Record<string, unknown> }>;
    };
    const row = list.apps.find((a) => a.appId === "origin-app")!;
    expect(row.manifest["name"]).toBe("Approved");
    expect(row.manifest["localRun"]).toBeUndefined();
  });

  it("refuses an uninstall and a registry read from a web page, even with Origin null", async () => {
    await installApp(server, testAppManifest({ id: "origin-null-app" }));
    const uninstall = await fetch(`${server.url}/admin/apps/origin-null-app`, {
      method: "DELETE",
      headers: { Origin: "null" },
    });
    expect(uninstall.status).toBe(403);
    const read = await fetch(`${server.url}/admin/apps`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(read.status).toBe(403);

    const list = (await (await fetch(`${server.url}/admin/apps`)).json()) as {
      apps: Array<{ appId: string }>;
    };
    expect(list.apps.map((a) => a.appId)).toContain("origin-null-app");
  });

  it("refuses a sourceDir that is not a string", async () => {
    const res = await fetch(`${server.url}/admin/apps/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest: testAppManifest({ id: "odd-app" }), sourceDir: 7 }),
    });
    expect(res.status).toBe(400);
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
      body: JSON.stringify({
        manifest: { id: "bad-app", infraRequirements: { fileAccessAll: true } },
      }),
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
  const filesDir = () => join(server.starkeepDir, "objects", "apps", "doomed-app");

  async function notes(a: InstalledApp): Promise<Array<Record<string, unknown>>> {
    const query = await a.fetch(
      `/app-data/db/notes?where=${encodeURIComponent(JSON.stringify({ note_id: "kept" }))}`,
    );
    expect(query.status).toBe(200);
    return ((await query.json()) as { rows: Array<Record<string, unknown>> }).rows;
  }

  async function retainedIds(): Promise<string[]> {
    const res = await fetch(`${server.url}/admin/retained-app-data`);
    const { retained } = (await res.json()) as { retained: Array<{ appId: string }> };
    return retained.map((r) => r.appId);
  }

  function syncStateKeys(): string[] {
    const db = new DatabaseSync(join(server.starkeepDir, "data.db"), { readOnly: true });
    try {
      return (
        db.prepare("SELECT key FROM sync_state WHERE key LIKE 'doomed-app:%'").all() as Array<{
          key: string;
        }>
      ).map((r) => r.key);
    } finally {
      db.close();
    }
  }

  function seedSyncState(): void {
    const db = new DatabaseSync(join(server.starkeepDir, "data.db"));
    try {
      // The table exists only once a sync engine has run; this server has no cloud.
      db.exec(
        "CREATE TABLE IF NOT EXISTS sync_state (key text primary key, value_json text not null, updated_at integer not null)",
      );
      db.prepare(
        "INSERT OR REPLACE INTO sync_state (key, value_json, updated_at) VALUES (?, ?, 0)",
      ).run("doomed-app:peer_watermarks", "{}");
    } finally {
      db.close();
    }
  }

  beforeAll(async () => {
    app = await installApp(server, testAppManifest({ id: "doomed-app" }));
    const created = await createRecordWithBytes(app, { fileName: "survivor.jpg" });
    sharedRecordId = created.record.id;
    await app.fetch("/app-data/db/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { note_id: "kept", body: "still here" } }),
    });
    await putAppFile(app, "keep/me.bin", "app private bytes");
  });

  it("keeps the app's tables and files, and revokes its identity", async () => {
    // A body asking for deletion is ignored: uninstall has no destructive flag.
    const res = await fetch(`${server.url}/admin/apps/doomed-app`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleteData: true, retainData: false }),
    });
    expect(res.status).toBe(200);

    const list = await fetch(`${server.url}/admin/apps`);
    const { apps } = (await list.json()) as { apps: Array<{ appId: string }> };
    expect(apps.some((a) => a.appId === "doomed-app")).toBe(false);

    expect(registryTableNames()).toContain("doomed_app_syncable_notes");
    expect((await stat(filesDir())).isDirectory()).toBe(true);
    expect(await retainedIds()).toContain("doomed-app");

    const denied = await app.fetch("/data/types");
    expect(denied.status).toBe(401);

    // Shared records survive too, as they always have.
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

  it("previews kept data by counts", async () => {
    const res = await fetch(`${server.url}/admin/apps/doomed-app/data-preview`);
    expect(res.status).toBe(200);
    const preview = (await res.json()) as {
      installed: boolean;
      retained: boolean;
      totalRows: number;
      tables: Array<{ name: string; rowCount: number }>;
      files: { count: number; totalBytes: number } | null;
      cloudCopy: string;
    };
    expect(preview.installed).toBe(false);
    expect(preview.retained).toBe(true);
    expect(preview.tables.find((t) => t.name === "notes")?.rowCount).toBe(1);
    expect(preview.totalRows).toBe(1);
    expect(preview.files).toEqual({ count: 1, totalBytes: "app private bytes".length });
    // This server has no cloud, so nothing ever exchanged the app's data.
    expect(preview.cloudCopy).toBe("none");
  });

  it("uninstall of a never-installed app cleanly no-ops", async () => {
    const res = await fetch(`${server.url}/admin/apps/never-was`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("a reinstall adopts the kept rows and clears the kept-data record", async () => {
    const again = await installApp(server, testAppManifest({ id: "doomed-app" }));
    expect(again.hmacSecret).not.toBe(app.hmacSecret);
    expect(await notes(again)).toMatchObject([{ note_id: "kept", body: "still here" }]);
    expect(await retainedIds()).not.toContain("doomed-app");
    app = again;
  });

  it("refuses to delete an installed app's data", async () => {
    const res = await fetch(`${server.url}/admin/apps/doomed-app/delete-data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "doomed-app" }),
    });
    expect(res.status).toBe(409);
    expect(registryTableNames()).toContain("doomed_app_syncable_notes");
  });

  it("refuses a delete whose confirmation does not name the app", async () => {
    await fetch(`${server.url}/admin/apps/doomed-app`, { method: "DELETE" });
    for (const body of [{}, { confirm: "doomed" }, { confirm: true }]) {
      const res = await fetch(`${server.url}/admin/apps/doomed-app/delete-data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(registryTableNames()).toContain("doomed_app_syncable_notes");
    expect(await retainedIds()).toContain("doomed-app");
  });

  it("deletes kept data, files and sync state on a confirmed request", async () => {
    seedSyncState();
    expect(syncStateKeys()).toContain("doomed-app:peer_watermarks");

    const res = await fetch(`${server.url}/admin/apps/doomed-app/delete-data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "doomed-app" }),
    });
    expect(res.status).toBe(200);

    expect(registryTableNames().some((n) => n.startsWith("doomed_app_syncable_"))).toBe(false);
    await expect(stat(filesDir())).rejects.toThrow();
    expect(await retainedIds()).not.toContain("doomed-app");
    expect(syncStateKeys()).toEqual([]);

    const preview = await fetch(`${server.url}/admin/apps/doomed-app/data-preview`);
    expect(preview.status).toBe(404);
    const again = await fetch(`${server.url}/admin/apps/doomed-app/delete-data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "doomed-app" }),
    });
    expect(again.status).toBe(404);
  });

  it("a reinstall after deletion starts empty", async () => {
    const fresh = await installApp(server, testAppManifest({ id: "doomed-app" }));
    expect(await notes(fresh)).toEqual([]);
    await fetch(`${server.url}/admin/apps/doomed-app`, { method: "DELETE" });
  });
});
