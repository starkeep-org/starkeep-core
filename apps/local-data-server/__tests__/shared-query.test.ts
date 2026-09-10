/**
 * The query grammar over the shared plane: per-category metadata, and labels.
 *
 * The case that matters on both routes is the same one, and it is the reason
 * the metadata tables gained `record_type` at all: an app holding *some* of a
 * category's types must see exactly its own rows. A suite where the caller
 * holds the whole category would pass with no gate in the query at all.
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
/** Owns the images: readwrite on image/jpeg + image/png, and writes metadata. */
let owner: InstalledApp;
/** Holds **one** of the two image types, so the gate has something to cut. */
let reader: InstalledApp;

/** The jpeg records, newest capture first. */
const jpegs: { id: string; capturedAt: string; width: number }[] = [];
let pngId = "";

beforeAll(async () => {
  server = await startLocalDataServer();
  owner = await installApp(
    server,
    testAppManifest({
      id: "shared-query-owner",
      infraRequirements: {
        fileAccess: [
          {
            types: ["image/jpeg", "image/png"],
            access: "readwrite",
            metadataWrite: true,
            rationale: "test",
          },
        ],
        labelKeys: [{ key: "album", description: "Which album a photo is in" }],
      },
    }),
  );
  reader = await installApp(
    server,
    testAppManifest({
      id: "shared-query-reader",
      infraRequirements: {
        fileAccess: [{ types: ["image/jpeg"], access: "read", rationale: "test" }],
      },
    }),
  );

  for (const [index, capturedAt] of [
    "2026-09-01T00:00:00.000Z",
    "2026-09-05T00:00:00.000Z",
    "2026-09-09T00:00:00.000Z",
  ].entries()) {
    const width = 100 * (index + 1);
    const { record } = await createRecordWithBytes(owner, {
      fileName: `shot-${index}.jpg`,
      metadata: { width, height: 50, captured_at: capturedAt },
      labels: [{ key: "album", value: index === 0 ? "trip" : "home" }],
    });
    jpegs.push({ id: record.id, capturedAt, width });
  }
  // A png with metadata and a label. The reader holds no png grant, so it must
  // appear in neither route's answer.
  const png = await createRecordWithBytes(owner, {
    type: "image/png",
    contentType: "image/png",
    fileName: "unreadable.png",
    metadata: { width: 999, height: 999, captured_at: "2026-09-11T00:00:00.000Z" },
    labels: [{ key: "album", value: "home" }],
  });
  pngId = png.record.id;
}, 60_000);

afterAll(async () => {
  await server.stop();
});

async function metadataQuery(
  app: InstalledApp,
  category: string,
  params: Record<string, string> = {},
): Promise<Response> {
  const search = new URLSearchParams(params).toString();
  return app.fetch(`/data/metadata/${category}${search ? `?${search}` : ""}`);
}

async function labelQuery(
  app: InstalledApp,
  params: Record<string, string>,
): Promise<Response> {
  return app.fetch(`/data/labels?${new URLSearchParams(params).toString()}`);
}

describe("GET /data/metadata/:category", () => {
  it("returns only the rows whose record_type the caller may read", async () => {
    const res = await metadataQuery(reader, "image");
    expect(res.status).toBe(200);
    const { rows, truncated } = (await res.json()) as {
      rows: Record<string, unknown>[];
      truncated: boolean;
    };
    expect(truncated).toBe(false);
    // The png row exists in the same table and is not in the answer. That is
    // the whole point of the discriminant: the grant is inside the access path.
    expect(rows.map((r) => r["record_id"]).sort()).toEqual(jpegs.map((j) => j.id).sort());
    expect(rows.map((r) => r["record_id"])).not.toContain(pngId);
  });

  it("returns the png row to the app that holds the png grant", async () => {
    // The negative case above is only worth anything if the row is there to be
    // missed: the same table, the same query, one more grant.
    const { rows } = (await (await metadataQuery(owner, "image")).json()) as {
      rows: Record<string, unknown>[];
    };
    expect(rows.map((r) => r["record_id"])).toContain(pngId);
    expect(rows).toHaveLength(jpegs.length + 1);
  });

  it("does not return the grant discriminant", async () => {
    // `record_type` is on every row and carries the predicate above; it is not
    // part of the surface an app addresses, so a bare page must not leak it.
    const { rows } = (await (await metadataQuery(reader, "image")).json()) as {
      rows: Record<string, unknown>[];
    };
    expect(Object.keys(rows[0]!)).not.toContain("record_type");
    expect(Object.keys(rows[0]!)).toContain("captured_at");
  });

  it("refuses a predicate on the grant discriminant", async () => {
    const res = await metadataQuery(reader, "image", {
      where: JSON.stringify({ record_type: "image/jpeg" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("record_type");
  });

  it("orders by capture time, which is what the index is for", async () => {
    const res = await metadataQuery(reader, "image", { order: "captured_at.desc" });
    const { rows } = (await res.json()) as { rows: Record<string, unknown>[] };
    expect(rows.map((r) => r["captured_at"])).toEqual(
      [...jpegs].map((j) => j.capturedAt).reverse(),
    );
  });

  it("pages with a keyset token that walks every row once", async () => {
    const seen: unknown[] = [];
    let token: string | null = null;
    do {
      const res: Response = await metadataQuery(reader, "image", {
        order: "captured_at.desc",
        limit: "2",
        ...(token ? { page_token: token } : {}),
      });
      const body = (await res.json()) as {
        rows: Record<string, unknown>[];
        page_token: string | null;
      };
      seen.push(...body.rows.map((r) => r["record_id"]));
      token = body.page_token;
    } while (token);
    expect(seen).toEqual([...jpegs].reverse().map((j) => j.id));
  });

  it("filters and aggregates over the caller's rows only", async () => {
    const res = await metadataQuery(reader, "image", {
      aggregate: JSON.stringify({
        n: { fn: "count" },
        widest: { fn: "max", col: "width" },
      }),
    });
    expect(res.status).toBe(200);
    const { groups } = (await res.json()) as { groups: Record<string, unknown>[] };
    // Three jpegs, not four rows: the png's 999 is in the table and out of
    // reach, so a count that included it would be visible here.
    expect(groups).toEqual([{ n: 3, widest: 300 }]);
  });

  it("403s a category the caller holds no type in", async () => {
    const res = await metadataQuery(reader, "video");
    expect(res.status).toBe(403);
  });

  it("400s the category with no metadata table", async () => {
    const res = await metadataQuery(owner, "other");
    expect(res.status).toBe(400);
  });

  it("400s a path segment that is not a category", async () => {
    expect((await metadataQuery(owner, "image%2Fjpeg")).status).toBe(400);
  });
});

describe("GET /data/labels", () => {
  it("requires app_id and key, because the reverse index does", async () => {
    const res = await labelQuery(reader, { where: JSON.stringify({ key: "album" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("app_id");
  });

  it("returns another app's labels, gated on the labelled record's type", async () => {
    // A label is a cross-app assertion, so the caller reading `shared-query-owner`'s
    // labels is the normal case rather than the exception. What restricts the
    // answer is the record's type, which the reader holds for jpeg only.
    const res = await labelQuery(reader, {
      where: JSON.stringify({ app_id: owner.appId, key: "album" }),
    });
    expect(res.status).toBe(200);
    const { rows } = (await res.json()) as { rows: Record<string, unknown>[] };
    expect(rows.map((r) => r["record_id"]).sort()).toEqual(jpegs.map((j) => j.id).sort());
    expect(rows.map((r) => r["record_id"])).not.toContain(pngId);
  });

  it("lets the owner see the label the reader cannot", async () => {
    const res = await labelQuery(owner, {
      where: JSON.stringify({ app_id: owner.appId, key: "album" }),
    });
    const { rows } = (await res.json()) as { rows: Record<string, unknown>[] };
    expect(rows.map((r) => r["record_id"])).toContain(pngId);
  });

  it("narrows on value, which is an ordered key column of the index", async () => {
    const res = await labelQuery(reader, {
      where: JSON.stringify({ app_id: owner.appId, key: "album", value: "trip" }),
    });
    const { rows } = (await res.json()) as { rows: Record<string, unknown>[] };
    expect(rows.map((r) => r["record_id"])).toEqual([jpegs[0]!.id]);
  });

  it("counts per value in the engine rather than in the browser", async () => {
    // The faceted count the plan names as the largest win on this surface:
    // one index scan against a tally over every label row.
    const res = await labelQuery(reader, {
      where: JSON.stringify({ app_id: owner.appId, key: "album" }),
      select: "value",
      aggregate: JSON.stringify({ n: { fn: "count" } }),
      order: "n.desc",
    });
    expect(res.status).toBe(200);
    const { groups } = (await res.json()) as { groups: Record<string, unknown>[] };
    // "home" is on two jpegs and on the png; the png is not the reader's.
    expect(groups).toEqual([
      { value: "home", n: 2 },
      { value: "trip", n: 1 },
    ]);
  });
});
