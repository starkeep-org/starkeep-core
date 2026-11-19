/**
 * The row queries behind collections, the note filters and the sample load.
 *
 * Each test stubs `fetch`, calls one operation, and reads back the query the
 * page sent. The e2e suite checks that the data servers accept each query and
 * answer it as the page expects; these tests pin the query's shape, and how
 * the page folds a joined answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_COLLECTIONS, SAMPLE_FILES } from "@example-app/common";
import * as api from "../src/browser/api.js";

interface Sent {
  method: string;
  url: URL;
  body: unknown;
}

let sent: Sent[] = [];

/** A JSON body parsed; a text body, such as stored bytes, as it is. */
function parseBody(init: RequestInit): unknown {
  if (typeof init.body !== "string") return init.body;
  const headers = (init.headers ?? {}) as Record<string, string>;
  return headers["Content-Type"] === "application/json" ? JSON.parse(init.body) : init.body;
}

/** Answer every request with `answer(sent)`, recording what was sent. */
function stub(answer: (s: Sent) => unknown): void {
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const s: Sent = {
      method: init.method ?? "GET",
      url: new URL(url, "http://page.example/"),
      body: parseBody(init),
    };
    sent.push(s);
    return Response.json(answer(s));
  });
}

const param = (s: Sent, name: string): unknown => JSON.parse(s.url.searchParams.get(name)!);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listCollections", () => {
  it("left-joins the items and counts the joined key, so an empty collection counts 0", async () => {
    stub(() => ({
      groups: [
        { id: "c1", name: "Empty", archived: false, files: 0 },
        { id: "c2", name: "Full", archived: true, files: "2" },
      ],
      truncated: false,
    }));

    expect(await api.listCollections()).toEqual([
      { id: "c1", name: "Empty", archived: false, files: 0 },
      { id: "c2", name: "Full", archived: true, files: 2 },
    ]);
    const [s] = sent;
    expect(s!.url.pathname).toBe("/api/local-data/app-data/db/collections");
    expect(param(s!, "join")).toEqual([
      {
        table: "collection_items",
        kind: "left",
        on: { "collection_items.collection_id": { eq: { col: "collections.id" } } },
      },
    ]);
    expect(s!.url.searchParams.get("select")).toBe("id,name,archived");
    expect(param(s!, "aggregate")).toEqual({
      files: { fn: "count", col: "collection_items.record_id" },
    });
  });
});

describe("collectionContents", () => {
  it("joins notes, the other items under an alias, and their collections with the archive filter in on", async () => {
    stub(() => ({ rows: [], truncated: false }));
    await api.collectionContents("c1");

    const [s] = sent;
    expect(s!.url.pathname).toBe("/api/local-data/app-data/db/collection_items");
    expect(param(s!, "where")).toEqual({ collection_id: { eq: "c1" } });
    expect(param(s!, "join")).toEqual([
      {
        table: "notes",
        kind: "left",
        on: { "notes.record_id": { eq: { col: "collection_items.record_id" } } },
      },
      {
        table: "collection_items",
        as: "other",
        kind: "left",
        on: {
          "other.record_id": { eq: { col: "collection_items.record_id" } },
          "other.collection_id": { ne: { col: "collection_items.collection_id" } },
        },
      },
      {
        table: "collections",
        kind: "left",
        on: {
          "collections.id": { eq: { col: "other.collection_id" } },
          "collections.archived": false,
        },
      },
    ]);
    // A joined query must name its columns, and the file comes first in the
    // order so each file's rows arrive together.
    expect(s!.url.searchParams.get("select")).toBe(
      "record_id,added_on,notes.record_id,notes.note,collections.id,collections.name",
    );
    expect(param(s!, "order")).toEqual([
      { col: "added_on", dir: "desc", nulls: "last" },
      { col: "record_id" },
      { col: "collections.name", nulls: "last" },
    ]);
  });

  it("folds one file's joined rows into one entry, across pages", async () => {
    const pages = [
      {
        rows: [
          {
            record_id: "r1",
            added_on: "2026-11-19T00:00:00.000Z",
            "notes.record_id": "r1",
            "notes.note": "a note",
            "collections.id": "c2",
            "collections.name": "Reading list",
          },
        ],
        truncated: true,
        page_token: "next",
      },
      {
        rows: [
          {
            record_id: "r1",
            added_on: "2026-11-19T00:00:00.000Z",
            "notes.record_id": "r1",
            "notes.note": "a note",
            "collections.id": "c3",
            "collections.name": "Recipes",
          },
          // No note, and the only other collection is archived: the row
          // stays, with null joined columns.
          {
            record_id: "r2",
            added_on: "2026-11-18T00:00:00.000Z",
            "notes.record_id": null,
            "notes.note": null,
            "collections.id": null,
            "collections.name": null,
          },
        ],
        truncated: false,
      },
    ];
    stub(() => pages.shift());

    expect(await api.collectionContents("c1")).toEqual([
      {
        recordId: "r1",
        addedOn: "2026-11-19T00:00:00.000Z",
        note: "a note",
        alsoIn: ["Reading list", "Recipes"],
      },
      { recordId: "r2", addedOn: "2026-11-18T00:00:00.000Z", note: null, alsoIn: [] },
    ]);
    expect(sent[1]!.url.searchParams.get("page_token")).toBe("next");
  });
});

describe("collectionsHolding and collectionsLacking", () => {
  const subquery = [
    {
      table: "collection_items",
      where: {
        "collection_items.collection_id": { eq: { col: "collections.id" } },
        "collection_items.record_id": "r1",
      },
    },
  ];

  it("asks exists for the collections that hold the file", async () => {
    stub(() => ({ rows: [{ id: "c1", name: "Recipes", archived: false }], truncated: false }));
    expect(await api.collectionsHolding("r1")).toEqual([
      { id: "c1", name: "Recipes", archived: false },
    ]);
    expect(param(sent[0]!, "where")).toEqual({ exists: subquery });
  });

  it("asks not_exists for the unarchived collections that lack it", async () => {
    stub(() => ({ rows: [], truncated: false }));
    await api.collectionsLacking("r1");
    expect(param(sent[0]!, "where")).toEqual({
      archived: { is: false },
      not_exists: subquery,
    });
  });
});

describe("searchNotes", () => {
  const recordIdFilters = async (files: api.NoteFiles) => {
    stub(() => ({ rows: [], truncated: false }));
    await api.searchNotes({ files });
    return sent.map((s) => (param(s, "where") as { record_id?: unknown }).record_id);
  };

  it("uses in and not_in with a list for the files on the page", async () => {
    expect(await recordIdFilters({ kind: "page", ids: ["r1"] })).toEqual([
      { in: ["r1"] },
      { in: ["r1"] },
    ]);
    expect(await recordIdFilters({ kind: "notPage", ids: ["r1"] })).toEqual([
      { not_in: ["r1"] },
      { not_in: ["r1"] },
    ]);
  });

  it("leaves an empty not_in list out, and asks nothing for an empty in list", async () => {
    expect(await recordIdFilters({ kind: "notPage", ids: [] })).toEqual([undefined, undefined]);
    expect(await recordIdFilters({ kind: "page", ids: [] })).toEqual([]);
  });

  it("uses in and not_in with a subquery for collections", async () => {
    const select = "collection_items.record_id";
    expect(await recordIdFilters({ kind: "collection", collectionId: "c1" })).toEqual([
      {
        in: {
          table: "collection_items",
          select,
          where: { "collection_items.collection_id": "c1" },
        },
      },
      {
        in: {
          table: "collection_items",
          select,
          where: { "collection_items.collection_id": "c1" },
        },
      },
    ]);
    expect(await recordIdFilters({ kind: "noCollection" })).toEqual([
      { not_in: { table: "collection_items", select } },
      { not_in: { table: "collection_items", select } },
    ]);
  });
});

describe("loadSampleData", () => {
  it("does nothing while a live sample file exists", async () => {
    stub(() => ({ records: [{ id: "r1" }] }));
    expect(await api.loadSampleData()).toEqual({ loaded: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url.searchParams.get("label")).toBe("example-app/sample");
  });

  /**
   * Answer a sample load. Each new record's id is `id:<file name>`, so a test
   * can check that each note and membership names its own file's record.
   * `deletedCollections` answer their `ifAbsent` insert as a deleted row.
   */
  function stubLoad(deletedCollections: readonly string[] = []): void {
    stub((s) => {
      if (s.method === "GET") return { records: [] };
      if (s.url.pathname.endsWith("/data/files"))
        return { key: "k", contentHash: "h", sizeBytes: 1 };
      if (s.url.pathname.endsWith("/data/records")) {
        return { record: { id: `id:${(s.body as { fileName: string }).fileName}` } };
      }
      const row = (s.body as { row?: { id?: string } }).row;
      if (
        s.url.pathname.endsWith("/app-data/db/collections") &&
        deletedCollections.includes(row?.id ?? "")
      ) {
        return { ok: true, changes: 0, skipped: "deleted" };
      }
      return { ok: true, changes: 1 };
    });
  }

  const posts = (table: string) =>
    sent.filter((s) => s.method === "POST" && s.url.pathname.endsWith(`/app-data/db/${table}`));
  const rowsOf = (table: string) =>
    posts(table).map((s) => (s.body as { row: Record<string, unknown> }).row);
  const pairs = (rows: Record<string, unknown>[]) =>
    rows.map((r) => `${String(r["collection_id"])} ${String(r["record_id"])}`).sort();

  it("writes every file, a derived copy, and the rows with ifAbsent", async () => {
    stubLoad();

    expect(await api.loadSampleData()).toEqual({ loaded: true, files: SAMPLE_FILES.length + 1 });

    const records = sent.filter(
      (s) => s.method === "POST" && s.url.pathname.endsWith("/data/records"),
    );
    expect(records).toHaveLength(SAMPLE_FILES.length + 1);
    for (const r of records) {
      expect((r.body as { labels: { key: string }[] }).labels).toContainEqual({
        key: "sample",
        value: "",
      });
    }
    const derived = records.filter((r) => (r.body as { parentId?: string }).parentId);
    expect(derived.map((r) => (r.body as { parentId: string }).parentId)).toEqual([
      "id:poem.skexample",
    ]);

    expect(rowsOf("collections").map((r) => r["id"])).toEqual(SAMPLE_COLLECTIONS.map((c) => c.id));
    // Each note and membership names its own file's record.
    expect(
      rowsOf("notes")
        .map((r) => `${String(r["record_id"])} ${String(r["note"])}`)
        .sort(),
    ).toEqual(
      SAMPLE_FILES.filter((f) => f.note)
        .map((f) => `id:${f.name} ${f.note!.text}`)
        .sort(),
    );
    expect(pairs(rowsOf("collection_items"))).toEqual(
      SAMPLE_FILES.flatMap((f) => f.collections.map((c) => `${c} id:${f.name}`)).sort(),
    );
    for (const s of [...posts("collections"), ...posts("notes"), ...posts("collection_items")]) {
      expect((s.body as { ifAbsent?: boolean }).ifAbsent).toBe(true);
    }
  });

  it("puts no file in a sample collection the person deleted", async () => {
    // The delete left a tombstone, so the ifAbsent insert skips the row. A
    // membership in it would count the file as in a collection that no
    // longer shows.
    stubLoad(["sample-recipes"]);

    await api.loadSampleData();

    expect(pairs(rowsOf("collection_items"))).toEqual(
      SAMPLE_FILES.flatMap((f) =>
        f.collections.filter((c) => c !== "sample-recipes").map((c) => `${c} id:${f.name}`),
      ).sort(),
    );
  });
});

describe("deleteRecord", () => {
  it("moves the file to the Trash and leaves its note and memberships alone", async () => {
    stub(() => ({ ids: ["r1", "r1-copy"] }));
    expect(await api.deleteRecord("r1")).toEqual(["r1", "r1-copy"]);
    // The MCP trash_file tool sends the same one request, through trashFile.
    expect(sent.map((s) => `${s.method} ${s.url.pathname}`)).toEqual([
      "DELETE /api/local-data/data/records/r1",
    ]);
  });
});
