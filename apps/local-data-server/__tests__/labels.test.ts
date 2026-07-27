/**
 * Cross-app record labels over HTTP.
 *
 * The case that matters is the *cross-app* one: an app holding only a `read`
 * grant on a type, labelling records another app created. A test where the
 * origin app labels its own records would exercise none of what is new.
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
/** Owns the images: readwrite on image/jpeg + image/png. */
let owner: InstalledApp;
/** Third party: **read-only** on image/jpeg, declares two label keys. */
let annotator: InstalledApp;
/** Declares no label keys at all. */
let silent: InstalledApp;

beforeAll(async () => {
  server = await startLocalDataServer();
  owner = await installApp(
    server,
    testAppManifest({
      id: "owner",
      infraRequirements: {
        fileAccess: [
          { types: ["image/jpeg", "image/png"], access: "readwrite", rationale: "test" },
        ],
        labelKeys: [{ key: "thumbnail", description: "A derived thumbnail" }],
      },
    }),
  );
  annotator = await installApp(
    server,
    testAppManifest({
      id: "annotator",
      infraRequirements: {
        // Read only. Labelling must work anyway — that is the whole point of
        // pricing a label write at a read grant.
        fileAccess: [{ types: ["image/jpeg"], access: "read", rationale: "test" }],
        labelKeys: [
          { key: "faces-detected", description: "Faces were found in this image" },
          { key: "face-count", description: "How many faces" },
        ],
      },
    }),
  );
  silent = await installApp(
    server,
    testAppManifest({
      id: "silent",
      infraRequirements: {
        fileAccess: [{ types: ["image/jpeg"], access: "read", rationale: "test" }],
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await server.stop();
});

async function setLabels(
  app: InstalledApp,
  labels: Array<{ recordId: string; key: string; value?: string | null }>,
): Promise<Response> {
  return app.fetch("/data/labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels }),
  });
}

describe("writing labels", () => {
  it("lets a read-only app label another app's record", async () => {
    const { record } = await createRecordWithBytes(owner, { fileName: "read-grant.jpg" });

    const res = await setLabels(annotator, [
      { recordId: record.id, key: "faces-detected" },
      { recordId: record.id, key: "face-count", value: "3" },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ written: 2 });
  });

  it("rejects a key the app's manifest does not declare", async () => {
    const { record } = await createRecordWithBytes(owner, { fileName: "undeclared.jpg" });
    const res = await setLabels(annotator, [{ recordId: record.id, key: "not-declared" }]);
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toContain("not declared");
  });

  it("rejects every key from an app that declared none", async () => {
    const { record } = await createRecordWithBytes(owner, { fileName: "silent.jpg" });
    const res = await setLabels(silent, [{ recordId: record.id, key: "anything" }]);
    expect(res.status).toBe(400);
  });

  it("403s a label on a type the app cannot read", async () => {
    // annotator has image/jpeg only; this is a png.
    const { record } = await createRecordWithBytes(owner, {
      type: "image/png",
      contentType: "image/png",
      fileName: "unreadable.png",
    });
    const res = await setLabels(annotator, [{ recordId: record.id, key: "faces-detected" }]);
    expect(res.status).toBe(403);
  });

  it("rejects a label on a record that does not exist", async () => {
    const res = await setLabels(annotator, [
      { recordId: "01J000000000000000000MISSING", key: "faces-detected" },
    ]);
    expect(res.status).toBe(400);
  });

  it("rejects an oversized value", async () => {
    const { record } = await createRecordWithBytes(owner, { fileName: "big-value.jpg" });
    const res = await setLabels(annotator, [
      { recordId: record.id, key: "face-count", value: "x".repeat(200) },
    ]);
    expect(res.status).toBe(400);
  });

  it("updates a label in place rather than duplicating it", async () => {
    const { record } = await createRecordWithBytes(owner, { fileName: "upsert.jpg" });
    await setLabels(annotator, [{ recordId: record.id, key: "face-count", value: "1" }]);
    await setLabels(annotator, [{ recordId: record.id, key: "face-count", value: "9" }]);

    const labels = await labelsFor(owner, record.id);
    const counts = labels.filter((l) => l.key === "face-count");
    expect(counts).toHaveLength(1);
    expect(counts[0].value).toBe("9");
  });

  it("has no way to express another app's namespace", async () => {
    // app_id is server-set from the authenticated subject, so a request
    // carrying one is not rejected — it is simply not a thing the body has.
    // The label lands under the *caller's* id whatever it claims.
    const { record } = await createRecordWithBytes(owner, { fileName: "no-squat.jpg" });
    const res = await annotator.fetch("/data/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        labels: [{ recordId: record.id, key: "faces-detected", appId: "owner" }],
      }),
    });
    expect(res.status).toBe(200);

    const labels = await labelsFor(owner, record.id);
    expect(labels.map((l) => l.app_id)).toEqual(["annotator"]);
  });
});

describe("reading labels", () => {
  it("hydrates labels only when include=labels is asked for", async () => {
    const { record } = await createRecordWithBytes(owner, { fileName: "hydrate.jpg" });
    await setLabels(annotator, [{ recordId: record.id, key: "face-count", value: "2" }]);

    const withLabels = await listWith(owner, "?include=labels&limit=1000");
    const row = withLabels.find((r) => r.id === record.id)!;
    expect(row.labels).toEqual([
      { app_id: "annotator", key: "face-count", value: "2", label: "annotator/face-count" },
    ]);

    const without = await listWith(owner, "?limit=1000");
    expect(without.find((r) => r.id === record.id)!.labels).toBeUndefined();
  });

  it("returns an empty array, not null, for a record with no labels", async () => {
    const { record } = await createRecordWithBytes(owner, { fileName: "unlabelled.jpg" });
    const rows = await listWith(owner, "?include=labels&limit=1000");
    expect(rows.find((r) => r.id === record.id)!.labels).toEqual([]);
  });

  it("shows every app's labels to any app that can read the type", async () => {
    // No per-namespace read gating: labels are assertions offered to other
    // apps, so hiding who said what would defeat the point.
    const { record } = await createRecordWithBytes(owner, { fileName: "cross-read.jpg" });
    await setLabels(annotator, [{ recordId: record.id, key: "faces-detected" }]);
    await setLabels(owner, [{ recordId: record.id, key: "thumbnail" }]);

    const seenByAnnotator = await labelsFor(annotator, record.id);
    expect(new Set(seenByAnnotator.map((l) => l.label))).toEqual(
      new Set(["annotator/faces-detected", "owner/thumbnail"]),
    );
  });

  it("narrows hydration to the namespaces asked for with labelApps", async () => {
    const { record } = await createRecordWithBytes(owner, { fileName: "narrow.jpg" });
    await setLabels(annotator, [{ recordId: record.id, key: "faces-detected" }]);
    await setLabels(owner, [{ recordId: record.id, key: "thumbnail" }]);

    const rows = await listWith(owner, "?include=labels&labelApps=owner&limit=1000");
    expect(rows.find((r) => r.id === record.id)!.labels).toEqual([
      { app_id: "owner", key: "thumbnail", value: null, label: "owner/thumbnail" },
    ]);
  });

  it("combines with include=metadata in the same comma list", async () => {
    const { record } = await createRecordWithBytes(owner, { fileName: "both.jpg" });
    await setLabels(annotator, [{ recordId: record.id, key: "faces-detected" }]);

    const rows = await listWith(owner, "?include=metadata,labels&limit=1000");
    const row = rows.find((r) => r.id === record.id)!;
    expect(row.labels).toHaveLength(1);
    expect("metadata" in row).toBe(true);
  });
});

describe("reverse query", () => {
  it("finds records another app labelled, across the namespace boundary", async () => {
    const a = await createRecordWithBytes(owner, { fileName: "rev-a.jpg" });
    const b = await createRecordWithBytes(owner, { fileName: "rev-b.jpg" });
    await createRecordWithBytes(owner, { fileName: "rev-c.jpg" });
    await setLabels(annotator, [
      { recordId: a.record.id, key: "faces-detected" },
      { recordId: b.record.id, key: "faces-detected" },
    ]);

    const found = await listWith(owner, "?label=annotator/faces-detected&limit=1000");
    const ids = new Set(found.map((r) => r.id));
    expect(ids.has(a.record.id)).toBe(true);
    expect(ids.has(b.record.id)).toBe(true);
  });

  it("filters by exact value with labelValue", async () => {
    const one = await createRecordWithBytes(owner, { fileName: "val-1.jpg" });
    const two = await createRecordWithBytes(owner, { fileName: "val-2.jpg" });
    await setLabels(annotator, [
      { recordId: one.record.id, key: "face-count", value: "1" },
      { recordId: two.record.id, key: "face-count", value: "7" },
    ]);

    const found = await listWith(owner, "?label=annotator/face-count&labelValue=7&limit=1000");
    const ids = new Set(found.map((r) => r.id));
    expect(ids.has(two.record.id)).toBe(true);
    expect(ids.has(one.record.id)).toBe(false);
  });

  it("400s labelValue without label", async () => {
    const res = await owner.fetch("/data/records?labelValue=7");
    expect(res.status).toBe(400);
  });

  it("400s a malformed label ref", async () => {
    const res = await owner.fetch("/data/records?label=no-slash");
    expect(res.status).toBe(400);
  });

  it("pages to exhaustion without skipping or repeating", async () => {
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { record } = await createRecordWithBytes(owner, { fileName: `page-rev-${i}.jpg` });
      made.push(record.id);
    }
    await setLabels(
      annotator,
      made.map((id) => ({ recordId: id, key: "faces-detected" })),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const res = await owner.fetch(
        `/data/records?label=annotator/faces-detected&limit=2${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      );
      const body = (await res.json()) as {
        records: Array<{ id: string }>;
        nextCursor: string | null;
      };
      seen.push(...body.records.map((r) => r.id));
      cursor = body.nextCursor;
      expect(++guard).toBeLessThan(50);
    } while (cursor !== null);

    expect(new Set(seen).size).toBe(seen.length);
    for (const id of made) expect(seen).toContain(id);
  });
});

describe("retraction", () => {
  it("hides a retracted label from both read paths", async () => {
    const { record } = await createRecordWithBytes(owner, { fileName: "retract.jpg" });
    await setLabels(annotator, [{ recordId: record.id, key: "faces-detected" }]);

    const res = await annotator.fetch("/data/labels/retract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [{ recordId: record.id, key: "faces-detected" }] }),
    });
    expect(res.status).toBe(200);

    expect(await labelsFor(owner, record.id)).toEqual([]);
    const found = await listWith(owner, "?label=annotator/faces-detected&limit=1000");
    expect(found.some((r) => r.id === record.id)).toBe(false);
  });

  it("cannot retract another app's label", async () => {
    // Scoped by primary key, which contains the server-set app_id — so this
    // is a silent no-op rather than an error, and owner's label survives.
    const { record } = await createRecordWithBytes(owner, { fileName: "cross-retract.jpg" });
    await setLabels(owner, [{ recordId: record.id, key: "thumbnail" }]);

    await annotator.fetch("/data/labels/retract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [{ recordId: record.id, key: "thumbnail" }] }),
    });

    expect((await labelsFor(owner, record.id)).map((l) => l.label)).toEqual(["owner/thumbnail"]);
  });
});

describe("labels on create", () => {
  it("accepts labels in the same request as the record", async () => {
    const upload = await owner.fetch("/data/files?type=image/jpeg", {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: Buffer.from("create-with-labels"),
    });
    const { contentHash, sizeBytes } = (await upload.json()) as {
      contentHash: string;
      sizeBytes: number;
    };
    const res = await owner.fetch("/data/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "image/jpeg",
        contentType: "image/jpeg",
        contentHash,
        sizeBytes,
        fileName: "created-with-labels.jpg",
        labels: [{ key: "thumbnail" }],
      }),
    });
    expect(res.status).toBe(200);
    const { record } = (await res.json()) as { record: { id: string } };
    expect((await labelsFor(owner, record.id)).map((l) => l.label)).toEqual(["owner/thumbnail"]);
  });
});

describe("GET /data/label-keys", () => {
  it("enumerates every app's declared keys, not just the caller's", async () => {
    // Discoverability across apps is the reason keys are declared in a
    // manifest at all, so this must not be filtered by the caller's identity.
    const res = await silent.fetch("/data/label-keys");
    expect(res.status).toBe(200);
    const { labelKeys } = (await res.json()) as {
      labelKeys: Array<{ app_id: string; key: string; label: string; description: string }>;
    };
    const byLabel = new Map(labelKeys.map((k) => [k.label, k]));
    expect(byLabel.has("annotator/faces-detected")).toBe(true);
    expect(byLabel.has("owner/thumbnail")).toBe(true);
    expect(byLabel.get("annotator/face-count")!.description).toBe("How many faces");
  });

  it("filters to one app with ?app=", async () => {
    const res = await owner.fetch("/data/label-keys?app=annotator");
    const { labelKeys } = (await res.json()) as { labelKeys: Array<{ app_id: string }> };
    expect(labelKeys.length).toBeGreaterThan(0);
    expect(labelKeys.every((k) => k.app_id === "annotator")).toBe(true);
  });
});

// ---- helpers ---------------------------------------------------------------

interface WireLabel {
  app_id: string;
  key: string;
  value: string | null;
  label: string;
}

async function listWith(
  app: InstalledApp,
  query: string,
): Promise<Array<{ id: string; labels?: WireLabel[]; [k: string]: unknown }>> {
  const res = await app.fetch(`/data/records${query}`);
  if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
  return (
    (await res.json()) as { records: Array<{ id: string; labels?: WireLabel[] }> }
  ).records;
}

async function labelsFor(app: InstalledApp, recordId: string): Promise<WireLabel[]> {
  const rows = await listWith(app, "?include=labels&limit=1000");
  return rows.find((r) => r.id === recordId)?.labels ?? [];
}
