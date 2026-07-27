/**
 * What happens to labels when the app that wrote them is upgraded or removed.
 *
 * The asymmetry here is the whole point, and it is what an implementation that
 * runs every write path through one gate gets wrong: the *declarations* are
 * revoked on uninstall and on an upgrade that drops a key, while the *label
 * rows* are shared data and survive both. So a live row on an undeclared key is
 * the intended steady state — reads return it, new writes to that key are
 * rejected, and **retraction stays legal**, because refusing it would strand
 * rows permanently out of their own author's reach.
 *
 * Its own server, because every case here mutates installed manifests.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  installApp,
  testAppManifest,
  createRecordWithBytes,
  type InstalledApp,
} from "./helpers.js";

let server: LocalDataServer;
let owner: InstalledApp;
let annotator: InstalledApp;
let recordId: string;

/** The annotator's manifest, with whichever label keys it currently declares. */
function annotatorManifest(keys: string[]): Record<string, unknown> {
  return testAppManifest({
    id: "annotator",
    infraRequirements: {
      fileAccess: [{ types: ["image/jpeg"], access: "read", rationale: "test" }],
      labelKeys: keys.map((key) => ({ key, description: `desc for ${key}` })),
    },
  });
}

async function setLabel(app: InstalledApp, key: string, value?: string) {
  return app.fetch("/data/labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels: [{ recordId, key, ...(value ? { value } : {}) }] }),
  });
}

async function retractLabel(app: InstalledApp, key: string) {
  return app.fetch("/data/labels/retract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels: [{ recordId, key }] }),
  });
}

async function labelsOnRecord(app: InstalledApp): Promise<string[]> {
  const res = await app.fetch("/data/records?include=labels&limit=1000");
  const { records } = (await res.json()) as {
    records: Array<{ id: string; labels?: Array<{ label: string }> }>;
  };
  return (records.find((r) => r.id === recordId)?.labels ?? []).map((l) => l.label);
}

async function declaredKeys(app: InstalledApp): Promise<string[]> {
  const res = await app.fetch("/data/label-keys");
  const { labelKeys } = (await res.json()) as { labelKeys: Array<{ label: string }> };
  return labelKeys.map((k) => k.label);
}

beforeAll(async () => {
  server = await startLocalDataServer();
  owner = await installApp(
    server,
    testAppManifest({
      id: "owner",
      infraRequirements: {
        fileAccess: [{ types: ["image/jpeg"], access: "readwrite", rationale: "test" }],
      },
    }),
  );
  annotator = await installApp(server, annotatorManifest(["keep-me", "drop-me"]));

  const created = await createRecordWithBytes(owner, { fileName: "lifecycle.jpg" });
  recordId = created.record.id;

  expect((await setLabel(annotator, "keep-me")).status).toBe(200);
  expect((await setLabel(annotator, "drop-me", "v1")).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await server.stop();
});

describe("uninstall", () => {
  it("drops every declaration but keeps the labels the app asserted", async () => {
    const res = await fetch(`${server.url}/admin/apps/annotator`, { method: "DELETE" });
    expect(res.status).toBe(200);

    // Nobody can discover annotator's schema any more...
    expect(await declaredKeys(owner)).not.toContain("annotator/keep-me");
    expect(await declaredKeys(owner)).not.toContain("annotator/drop-me");
    // ...but a reader does not lose annotations because the producer was
    // temporarily removed. Shared data outlives the app that wrote it.
    expect(await labelsOnRecord(owner)).toEqual(
      expect.arrayContaining(["annotator/keep-me", "annotator/drop-me"]),
    );
  });

  it("still answers reverse queries for a departed app's labels", async () => {
    const res = await owner.fetch("/data/records?label=annotator/drop-me&limit=1000");
    const { records } = (await res.json()) as { records: Array<{ id: string }> };
    expect(records.map((r) => r.id)).toContain(recordId);
  });
});

describe("reinstalling with fewer keys leaves live rows on an undeclared key", () => {
  // This is the §10 steady state, and the only route to it on the local
  // server: `installLocal` returns early for an app that is already active, so
  // re-posting a changed manifest is a no-op rather than an upgrade. Removing
  // and reinstalling is what makes a manifest change land here.
  beforeAll(async () => {
    annotator = await installApp(server, annotatorManifest(["keep-me"]));
  });

  it("re-declares only the keys the new manifest names", async () => {
    expect(await declaredKeys(owner)).toContain("annotator/keep-me");
    expect(await declaredKeys(owner)).not.toContain("annotator/drop-me");
  });

  it("keeps reading the rows on the now-undeclared key", async () => {
    expect(await labelsOnRecord(owner)).toContain("annotator/drop-me");
  });

  it("rejects a NEW write to the undeclared key", async () => {
    const res = await setLabel(annotator, "drop-me", "v2");
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toContain("not declared");
    // The existing row is untouched by the rejected write.
    expect(await labelsOnRecord(owner)).toContain("annotator/drop-me");
  });

  it("ALLOWS retracting the undeclared key, so the app can clean up after itself", async () => {
    // The bug the obvious implementation has: validating the key on retraction
    // as well would leave these rows unreachable to the only app that may
    // touch them, permanently.
    const res = await retractLabel(annotator, "drop-me");
    expect(res.status).toBe(200);
    expect(await labelsOnRecord(owner)).not.toContain("annotator/drop-me");
  });

  it("updates the surviving row in place rather than writing a second one", async () => {
    expect((await setLabel(annotator, "keep-me", "back")).status).toBe(200);

    const res = await owner.fetch("/data/records?include=labels&limit=1000");
    const { records } = (await res.json()) as {
      records: Array<{ id: string; labels?: Array<{ label: string; value: string | null }> }>;
    };
    const labels = (records.find((r) => r.id === recordId)?.labels ?? []).filter(
      (l) => l.label === "annotator/keep-me",
    );
    expect(labels).toHaveLength(1);
    expect(labels[0].value).toBe("back");
  });
});
