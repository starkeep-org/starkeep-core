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

describe("uninstall preview", () => {
  let app: InstalledApp;

  beforeAll(async () => {
    app = await installApp(server, testAppManifest({ id: "preview-app" }));
    for (const [id, body] of [
      ["n1", "Sunset over the bay"],
      ["n2", "Mum's birthday"],
      ["n3", "Trip to Kyoto"],
      ["n4", "Groceries"],
    ] as const) {
      const res = await app.fetch("/app-data/db/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row: { note_id: id, body } }),
      });
      expect(res.ok).toBe(true);
    }
    await putAppFile(app, "attachments/small.bin", "x".repeat(10));
    await putAppFile(app, "attachments/large.bin", "x".repeat(5000));
  });

  it("counts the app's own rows and samples real values", async () => {
    const res = await fetch(`${server.url}/admin/apps/preview-app/uninstall-preview`);
    expect(res.status).toBe(200);
    const preview = (await res.json()) as {
      installed: boolean;
      tables: Array<{ name: string; rowCount: number; samples: string[] }>;
      files: { count: number; totalBytes: number; samples: Array<{ name: string }> } | null;
    };

    expect(preview.installed).toBe(true);
    const notes = preview.tables.find((t) => t.name === "notes");
    expect(notes).toBeDefined();
    expect(notes!.rowCount).toBe(4);
    // Samples are the human-written column, not the opaque primary key, and
    // are capped so the dialog stays a warning rather than a data dump.
    expect(notes!.samples).toHaveLength(3);
    for (const sample of notes!.samples) {
      expect(["Sunset over the bay", "Mum's birthday", "Trip to Kyoto", "Groceries"]).toContain(
        sample,
      );
    }

    // The reserved file-records table is reported as files, not as a table.
    expect(preview.tables.some((t) => t.name === "_starkeep_sync_records")).toBe(false);
    expect(preview.files).not.toBeNull();
    expect(preview.files!.count).toBe(2);
    expect(preview.files!.totalBytes).toBe(5010);
    // Largest first, so the sample names the file worth hesitating over.
    expect(preview.files!.samples[0]!.name).toBe("large.bin");
  });

  it("stops counting rows the app already retracted", async () => {
    const del = await app.fetch("/app-data/db/notes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ where: { note_id: "n4" } }),
    });
    expect(del.ok).toBe(true);

    const res = await fetch(`${server.url}/admin/apps/preview-app/uninstall-preview`);
    const preview = (await res.json()) as {
      tables: Array<{ name: string; rowCount: number; samples: string[] }>;
    };
    expect(preview.tables.find((t) => t.name === "notes")!.rowCount).toBe(3);
  });

  it("reports a never-installed app as not installed", async () => {
    const res = await fetch(`${server.url}/admin/apps/never-was/uninstall-preview`);
    expect(res.status).toBe(200);
    const preview = (await res.json()) as {
      installed: boolean;
      tables: unknown[];
      files: unknown;
    };
    expect(preview.installed).toBe(false);
    expect(preview.tables).toEqual([]);
    expect(preview.files).toBeNull();
  });

  it("reports no files for an app that never opted into app-specific files", async () => {
    const manifest = testAppManifest({ id: "no-files-app" }) as {
      infraRequirements: { appSpecificSyncable: { files: boolean } };
    };
    manifest.infraRequirements.appSpecificSyncable.files = false;
    await installApp(server, manifest as unknown as Record<string, unknown>);

    const res = await fetch(`${server.url}/admin/apps/no-files-app/uninstall-preview`);
    const preview = (await res.json()) as { files: unknown; tables: Array<{ rowCount: number }> };
    expect(preview.files).toBeNull();
    expect(preview.tables.every((t) => t.rowCount === 0)).toBe(true);

    await fetch(`${server.url}/admin/apps/no-files-app`, { method: "DELETE" });
  });

  afterAll(async () => {
    await fetch(`${server.url}/admin/apps/preview-app`, { method: "DELETE" });
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

  it("drops tables, grants, namespace, and the files prefix — shared records survive", async () => {
    const before = registryTableNames();
    expect(before).toContain("doomed_app_syncable_notes");

    const res = await fetch(`${server.url}/admin/apps/doomed-app`, { method: "DELETE" });
    expect(res.status).toBe(200);

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
    const res = await fetch(`${server.url}/admin/apps/never-was`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("reinstall after uninstall mints a fresh secret and a clean ledger", async () => {
    const again = await installApp(server, testAppManifest({ id: "doomed-app" }));
    expect(again.hmacSecret).not.toBe(app.hmacSecret);
    const ok = await again.fetch("/data/types");
    expect(ok.status).toBe(200);
    // Cleanup for other files' sake.
    await fetch(`${server.url}/admin/apps/doomed-app`, { method: "DELETE" });
  });
});
