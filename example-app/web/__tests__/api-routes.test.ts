/**
 * Route shapes that only fail in the cloud, across every operation the page
 * performs.
 *
 * API Gateway decodes `%2F` into a real slash before the data server sees the
 * path, so a path segment that holds an encoded slash reaches the server as two
 * segments and matches no route. The local server never decodes, so the e2e
 * suite cannot catch this. A query string is not decoded that way, so only the
 * path counts.
 *
 * Each exported function runs once against a stubbed `fetch` that answers
 * every request with one body holding every field any caller reads. A new
 * export without an entry in `CALLS` fails the coverage test, so the guard
 * keeps covering the whole file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../src/browser/api.js";

const RECORD: api.ExampleRecord = {
  id: "REC1",
  type: "example/plaintext",
  original_filename: "hello.skexample",
  size_bytes: 5,
  parent_id: null,
  created_at: "2026-11-16T00:00:00.000Z",
  updated_at: "2026-11-16T00:00:00.000Z",
};

/** One answer for every route: each caller reads only its own fields. */
const EVERYTHING = {
  record: RECORD,
  records: [RECORD],
  nextCursor: null,
  groups: [{ total: 1, n: 1, value: "draft" }],
  rows: [],
  truncated: false,
  page_token: null,
  url: "https://signed.example/content",
  urls: {},
  ids: ["REC1"],
  labelKeys: [],
  types: [],
  files: [],
  publicShare: { id: "S1" },
  publicShares: [],
  metadata: null,
  key: "k",
  contentHash: "h",
  sizeBytes: 5,
  signedIn: false,
  accessToken: "token",
  retention_days: 30,
  loadedAt: 1,
};

/** Every exported function, called once with ordinary arguments. */
const CALLS: Record<string, () => Promise<unknown>> = {
  runtimeConfig: () => api.runtimeConfig(),
  session: () => api.session(),
  refreshSession: () => api.refreshSession(),
  signOut: () => api.signOut(),
  callJwtRoute: () => api.callJwtRoute(true, "hello"),
  grantCheck: () => api.grantCheck(),
  createFromText: () => api.createFromText("a.skexample", "text"),
  uploadFile: () => api.uploadFile(new File(["text"], "a.skexample", { type: "text/plain" })),
  readContent: () => api.readContent("REC1"),
  deriveUppercase: () => api.deriveUppercase(RECORD),
  listRecords: async () => {
    await api.listRecords({ kind: "all" });
    await api.listRecords({ kind: "originals" });
    await api.listRecords({ kind: "children", parentId: "REC1" });
    await api.listRecords({ kind: "tag", value: "a/b" }, "TOKEN/1");
  },
  countRecords: () => api.countRecords(),
  getRecord: () => api.getRecord("REC1"),
  getMetadata: () => api.getMetadata("REC1"),
  fileUrls: () => api.fileUrls(["REC1"]),
  deleteRecord: () => api.deleteRecord("REC1"),
  deleteFile: () => api.deleteFile("REC1"),
  recomputeMetadata: () => api.recomputeMetadata("REC1"),
  queryMetadata: () => api.queryMetadata(),
  metadataTotals: () => api.metadataTotals(),
  addLabels: () => api.addLabels("REC1", ["draft"], true),
  setTags: () => api.setTags("REC1", ["draft"]),
  retractLabel: () => api.retractLabel("REC1", "tag", "draft"),
  tagCounts: () => api.tagCounts(),
  labelKeys: () => api.labelKeys(),
  getNote: () => api.getNote("REC1"),
  addNote: () =>
    api.addNote({ recordId: "REC1", text: "hi", pinned: false, updatedOn: "2026-11-16" }),
  updateNote: () => api.updateNote("REC1", { note: "hi" }, "stamp"),
  deleteNoteIfUnchanged: () => api.deleteNoteIfUnchanged("REC1", "stamp"),
  patchNote: () => api.patchNote("REC1", { pinned: true }),
  deleteNote: () => api.deleteNote("REC1"),
  searchNotes: () =>
    api.searchNotes({ text: "a/b", match: "starts", since: "2026-01-01", recordIds: ["REC1"] }),
  pinnedCount: () => api.pinnedCount(),
  notesByDay: () => api.notesByDay(0),
  saveExport: () => api.saveExport(),
  listExports: () => api.listExports(),
  openExport: () => api.openExport("exports/notes.json"),
  exportUrls: () => api.exportUrls(["exports/notes.json"]),
  deleteExport: () => api.deleteExport("exports/notes.json"),
  deletedSince: () => api.deletedSince("2026-11-16T00:00:00.000Z"),
  restoreRecord: () => api.restoreRecord("REC1"),
  trashPolicy: () => api.trashPolicy(),
  types: () => api.types(),
  listShares: () => api.listShares(),
  createShare: () => api.createShare("REC1", "a/b title"),
  revokeShare: () => api.revokeShare("S1"),
  cloudAddress: () => api.cloudAddress(),
};

let requested: string[] = [];

beforeEach(() => {
  requested = [];
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url);
    return Response.json(EVERYTHING);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("every exported operation", () => {
  it("has an entry here", () => {
    const exported = Object.entries(api)
      .filter(([name, value]) => typeof value === "function" && name !== "ApiError")
      .map(([name]) => name)
      .sort();
    expect(Object.keys(CALLS).sort()).toEqual(exported);
  });

  it.each(Object.keys(CALLS))("%s sends no encoded slash in a request path", async (name) => {
    await CALLS[name]!();
    expect(requested.length).toBeGreaterThan(0);
    for (const url of requested) {
      const path = new URL(url, "http://page.example/").pathname;
      expect(path, url).not.toMatch(/%2F/i);
    }
  });
});

describe("getMetadata", () => {
  it("names the category, so the last segment holds no slash", async () => {
    await api.getMetadata("REC1");
    expect(requested).toEqual(["/api/local-data/data/records/REC1/metadata/example"]);
  });
});
