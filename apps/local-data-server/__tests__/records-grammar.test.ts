/**
 * `/data/records`: the old parameter set and the grammar answer the same thing.
 *
 * Both spellings run through one parser, so the risk this suite covers is the
 * translation between them rather than the parser itself. Every case here
 * issues the *exact shape a production caller issues* against one seeded
 * fixture, in both spellings, and asserts one response — which is what licenses
 * migrating those callers one at a time.
 *
 * The route also has no golden-response coverage of its own, so the fixture is
 * worth having even where the two spellings are trivially equal.
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
/** Owns the library: readwrite on image/jpeg, metadata, and the label keys. */
let app: InstalledApp;

const RENDITION = "records-grammar/rendition";
/** The originals, in the order they were created. */
const originals: { id: string; capturedAt: string }[] = [];
/** One rendition child per original, carrying the rendition label. */
const renditions: string[] = [];

/**
 * More than the grammar's default page and fewer than this route's.
 *
 * The whole library has to come back on a request that names no `limit` for the
 * route's own default to be the thing under test; at 30 the two defaults are
 * indistinguishable.
 */
const ORIGINAL_COUNT = 34;

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(
    server,
    testAppManifest({
      id: "records-grammar",
      infraRequirements: {
        fileAccess: [
          {
            types: ["image/jpeg", "image/png"],
            access: "readwrite",
            metadataWrite: true,
            rationale: "test",
          },
        ],
        labelKeys: [{ key: "rendition", description: "Which size class this child is" }],
      },
    }),
  );

  for (let index = 0; index < ORIGINAL_COUNT; index += 1) {
    // Capture times run backwards through the set, so a capture-ordered page is
    // in a different order from an id-ordered one and the two are told apart.
    const capturedAt = `2026-09-01T00:${String(59 - index).padStart(2, "0")}:00.000Z`;
    const { record } = await createRecordWithBytes(app, {
      fileName: `shot-${index}.jpg`,
      bytes: `original-${index}`,
      metadata: { width: 4000, height: 3000, captured_at: capturedAt },
    });
    originals.push({ id: record.id, capturedAt });
  }
  // Two renditions, so `notLabel` and `parentId` both have something to cut.
  for (const parent of originals.slice(0, 2)) {
    const { record } = await createRecordWithBytes(app, {
      fileName: "thumb.jpg",
      bytes: `rendition-${parent.id}`,
      parentId: parent.id,
      metadata: { width: 400, height: 300 },
      labels: [{ key: "rendition", value: "thumbnail" }],
    });
    renditions.push(record.id);
  }
}, 120_000);

afterAll(async () => {
  await server.stop();
});

/**
 * One response, with the parts that cannot be equal removed.
 *
 * A file URL carries a token minted at request time and an `expires_at` a
 * second later, so two identical requests differ in exactly those fields and in
 * nothing else. Blanking them is what leaves the comparison about the query.
 */
async function body(query: string): Promise<unknown> {
  const res = await app.fetch(`/data/records${query}`);
  expect(res.status, `${query} → ${res.status}`).toBe(200);
  return scrubUrls(await res.json());
}

function scrubUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubUrls);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = key === "url" || key === "url_lifetime" ? "<scrubbed>" : scrubUrls(inner);
  }
  return out;
}

/** Both spellings of one production call site, asserted to be one answer. */
async function equivalent(legacy: string, grammar: string): Promise<unknown> {
  const answer = await body(legacy);
  expect(await body(grammar)).toEqual(answer);
  return answer;
}

describe("the route's own defaults, which are not the grammar's", () => {
  it("answers 100 records rather than the grammar's 30 when no limit is named", async () => {
    // The whole library is 36 records: above the grammar's default page and
    // below this route's, so a page of everything can only be the route's.
    const { records, hasMore } = (await body("")) as {
      records: unknown[];
      hasMore: boolean;
    };
    expect(records).toHaveLength(ORIGINAL_COUNT + renditions.length);
    expect(hasMore).toBe(false);
  });

  it("clamps a limit above the grammar's ceiling instead of rejecting it", async () => {
    // `?limit=1000` means "give me everything" to every caller this route has,
    // and the grammar would answer a 400. The page comes back with `hasMore`
    // and a cursor, so a caller that really has 500+ rows pages once more.
    const { records } = (await body("?limit=1000")) as { records: unknown[] };
    expect(records).toHaveLength(ORIGINAL_COUNT + renditions.length);
  });

  it("rejects a limit the grammar would reject for any other reason", async () => {
    const res = await app.fetch("/data/records?limit=0");
    expect(res.status).toBe(400);
  });
});

describe("the shapes production issues, in both spellings", () => {
  it("drive: the whole library", async () => {
    const answer = (await equivalent("?limit=1000", "?limit=1000")) as {
      records: { id: string }[];
    };
    expect(answer.records).toHaveLength(ORIGINAL_COUNT + renditions.length);
  });

  it("drive: the whole library of one type", async () => {
    const answer = (await equivalent(
      "?limit=1000&type=image/jpeg",
      `?limit=1000&where=${encodeURIComponent(JSON.stringify({ type: "image/jpeg" }))}`,
    )) as { records: { id: string }[] };
    expect(answer.records).toHaveLength(ORIGINAL_COUNT + renditions.length);
  });

  it("photos library: a page of originals with metadata and labels", async () => {
    const suffix =
      `&include=metadata,labels&notLabel=${encodeURIComponent(RENDITION)}`;
    const answer = (await equivalent(
      `?limit=10${suffix}`,
      `?limit=10${suffix}`,
    )) as { records: { id: string }[]; hasMore: boolean; nextCursor: string };
    // The renditions are cut by the anti-join, so the page is originals only.
    expect(answer.records.map((r) => r.id)).not.toContain(renditions[0]);
    expect(answer.hasMore).toBe(true);

    // The second page, which is the parameter the two spellings disagree on.
    expect(
      await body(`?limit=10${suffix}&page_token=${encodeURIComponent(answer.nextCursor)}`),
    ).toEqual(await body(`?limit=10${suffix}&cursor=${encodeURIComponent(answer.nextCursor)}`));
  });

  it("photos renditions: a bounded id list with metadata and variants", async () => {
    const ids = [originals[0]!.id, originals[1]!.id].sort();
    const answer = (await equivalent(
      `?ids=${encodeURIComponent(ids.join(","))}&include=metadata` +
        `&variant=${encodeURIComponent(RENDITION)}`,
      `?where=${encodeURIComponent(JSON.stringify({ id: { in: ids } }))}` +
        `&include=metadata&variant=${encodeURIComponent(RENDITION)}`,
    )) as { records: { id: string }[]; hasMore: boolean; nextCursor: string | null };
    expect(answer.records.map((r) => r.id).sort()).toEqual(ids);
    // A bounded list is the whole answer, so there is nothing to page.
    expect(answer.hasMore).toBe(false);
    expect(answer.nextCursor).toBeNull();
  });

  it("derivation sweep: originals with their variant candidates", async () => {
    const suffix =
      `&include=metadata,labels&notLabel=${encodeURIComponent(RENDITION)}` +
      `&variant=${encodeURIComponent(RENDITION)}`;
    await equivalent(`?limit=20${suffix}`, `?limit=20${suffix}`);
  });

  it("vision scan: a page of everything, labels included", async () => {
    await equivalent("?include=labels&limit=20", "?include=labels&limit=20");
  });

  it("publish-renditions: the children of one record, by label", async () => {
    const parent = originals[0]!.id;
    const answer = (await equivalent(
      `?parentId=${encodeURIComponent(parent)}&label=${RENDITION}` +
        `&include=labels,metadata&limit=50`,
      `?where=${encodeURIComponent(JSON.stringify({ parent_id: parent }))}` +
        `&label=${RENDITION}&include=labels,metadata&limit=50`,
    )) as { records: { id: string }[] };
    expect(answer.records.map((r) => r.id)).toEqual([renditions[0]]);
  });

  it("labels: one child of one record, at one label value", async () => {
    const parent = originals[1]!.id;
    const answer = (await equivalent(
      `?parentId=${encodeURIComponent(parent)}&label=${RENDITION}&labelValue=thumbnail&limit=1`,
      `?where=${encodeURIComponent(JSON.stringify({ parent_id: parent }))}` +
        `&label=${RENDITION}&labelValue=thumbnail&limit=1`,
    )) as { records: { id: string }[] };
    expect(answer.records.map((r) => r.id)).toEqual([renditions[1]]);
  });

  it("the parentless half of parentId, which has no other spelling", async () => {
    const answer = (await equivalent(
      "?parentId=none&limit=1000",
      `?where=${encodeURIComponent(JSON.stringify({ parent_id: null }))}&limit=1000`,
    )) as { records: { id: string }[] };
    expect(answer.records).toHaveLength(ORIGINAL_COUNT);
  });
});

describe("what the grammar reaches that the parameter set never could", () => {
  it("orders the library by capture time, newest first", async () => {
    const { records } = (await body("?order=captured_at.desc&limit=1000")) as {
      records: { id: string }[];
    };
    // The two renditions carry no capture time, so they sort into the null
    // bucket, which is last in both directions on purpose.
    const withCapture = [...originals].sort((a, b) =>
      a.capturedAt < b.capturedAt ? 1 : -1,
    );
    expect(records.slice(0, ORIGINAL_COUNT).map((r) => r.id)).toEqual(
      withCapture.map((o) => o.id),
    );
    expect(records.slice(ORIGINAL_COUNT).map((r) => r.id).sort()).toEqual(
      [...renditions].sort(),
    );
  });

  it("pages a capture-ordered library without losing or repeating a record", async () => {
    const seen: string[] = [];
    let token: string | null = null;
    for (let round = 0; round < 20; round += 1) {
      const page: { records: { id: string }[]; hasMore: boolean; nextCursor: string | null } =
        (await body(
          `?order=captured_at.desc&limit=7` +
            (token ? `&page_token=${encodeURIComponent(token)}` : ""),
        )) as { records: { id: string }[]; hasMore: boolean; nextCursor: string | null };
      seen.push(...page.records.map((r) => r.id));
      if (!page.hasMore) break;
      token = page.nextCursor;
      expect(token).not.toBeNull();
    }
    expect(seen).toHaveLength(ORIGINAL_COUNT + renditions.length);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("counts the readable library without paging through it", async () => {
    const res = await app.fetch(
      `/data/records?aggregate=${encodeURIComponent(JSON.stringify({ total: { fn: "count" } }))}`,
    );
    expect(res.status).toBe(200);
    const { groups } = (await res.json()) as { groups: { total: number }[] };
    expect(groups).toEqual([{ total: ORIGINAL_COUNT + renditions.length }]);
  });

  it("counts by type, which is the same question grouped", async () => {
    const res = await app.fetch(
      `/data/records?select=type&aggregate=` +
        encodeURIComponent(JSON.stringify({ n: { fn: "count" } })),
    );
    expect(res.status).toBe(200);
    const { groups } = (await res.json()) as { groups: { type: string; n: number }[] };
    expect(groups).toEqual([
      { type: "image/jpeg", n: ORIGINAL_COUNT + renditions.length },
    ]);
  });
});

describe("what the route refuses", () => {
  it("refuses a column the records table does not have", async () => {
    const res = await app.fetch(
      `/data/records?where=${encodeURIComponent(JSON.stringify({ nope: "x" }))}`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("nope");
  });

  it("refuses a predicate on captured_at, which is an ordering key and not a column", async () => {
    // The value lives in the metadata table and this route reads it through a
    // join it builds only to sort. Filtering it belongs on
    // `/data/metadata/image`, which addresses that table directly.
    const res = await app.fetch(
      `/data/records?where=${encodeURIComponent(JSON.stringify({ captured_at: "2026-09-01" }))}`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("order only");
  });

  it("refuses a predicate on the sync clock", async () => {
    const res = await app.fetch(
      `/data/records?where=${encodeURIComponent(JSON.stringify({ updated_at: "x" }))}`,
    );
    expect(res.status).toBe(400);
  });

  it("refuses both spellings of one thing in one request", async () => {
    const res = await app.fetch(
      `/data/records?type=image/jpeg&where=${encodeURIComponent(JSON.stringify({ id: "x" }))}`,
    );
    expect(res.status).toBe(400);
  });

  it("refuses a parameter it does not have", async () => {
    const res = await app.fetch("/data/records?parent_id=x");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("parent_id");
  });

  it("refuses nullsfirst, which its cursor cannot honour", async () => {
    const res = await app.fetch("/data/records?order=captured_at.desc.nullsfirst");
    expect(res.status).toBe(400);
  });

  it("refuses an aggregate over an access path it cannot compile", async () => {
    const res = await app.fetch(
      `/data/records?aggregate=${encodeURIComponent(JSON.stringify({ n: { fn: "count" } }))}` +
        `&notLabel=${encodeURIComponent(RENDITION)}`,
    );
    expect(res.status).toBe(400);
  });
});
