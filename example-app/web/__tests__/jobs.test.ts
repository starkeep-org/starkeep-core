/**
 * One run of each job, against fakes for the vault and the data server.
 *
 * The run's real calls carry the run's token to the platform, which the cloud
 * e2e suite drives. These tests hold what the run itself decides: it rotates
 * the provider token before anything else, it writes a tagged digest file,
 * and nothing it writes or reports holds the token.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultResult } from "@starkeep/app-client";
import { DataCallError, type DataCall } from "../src/server/data-call.js";
import {
  KEYWORDS_BATCH,
  fetchText,
  runDigest,
  runKeywords,
  type DigestDeps,
  type KeywordsDeps,
} from "../src/server/jobs.js";

const SECRET = "s3cret-token";
const AT = new Date("2026-11-20T07:00:12.000Z");

interface Sent {
  method: string;
  path: string;
  body?: { json?: unknown; text?: string };
}

function fakes(opts: { stored: string | null; readFails?: boolean; failOn?: string }): {
  deps: DigestDeps;
  sent: Sent[];
  puts: [string, string][];
} {
  const sent: Sent[] = [];
  const puts: [string, string][] = [];
  const data: DataCall = async (method, path, body) => {
    sent.push({ method, path, body });
    if (opts.failOn && path.startsWith(opts.failOn)) {
      throw new DataCallError(403, "The data server answered 403: refused");
    }
    if (method === "GET") return { groups: [{ n: path.includes("pinned") ? 2 : 5 }] };
    if (path.startsWith("/data/files")) return { contentHash: "h", sizeBytes: 10 };
    if (path === "/data/records") return { record: { id: "REC9" } };
    return {};
  };
  const deps: DigestDeps = {
    readSecret: async (): Promise<VaultResult<string | null>> =>
      opts.readFails
        ? { ok: false, cloudRequired: false, status: 403, error: "refused" }
        : { ok: true, value: opts.stored },
    putSecret: async (name, value): Promise<VaultResult<null>> => {
      puts.push([name, value]);
      return { ok: true, value: null };
    },
    data,
    now: () => AT,
  };
  return { deps, sent, puts };
}

function everythingSent(sent: Sent[]): string {
  return JSON.stringify(sent);
}

describe("a digest run", () => {
  it("rotates a stored provider token and names only the rotation", async () => {
    const { deps, sent, puts } = fakes({ stored: `${SECRET}#2` });
    const outcome = await runDigest("run-1", deps);
    expect(puts).toEqual([["provider-token", `${SECRET}#3`]]);
    expect(outcome).toEqual({
      status: 200,
      message: "Wrote digest-2026-11-20.skexample; provider token rotation 3",
    });
    expect(everythingSent(sent)).not.toContain(SECRET);
  });

  it("writes no secret when none is stored", async () => {
    const { deps, puts } = fakes({ stored: null });
    const outcome = await runDigest("run-1", deps);
    expect(puts).toEqual([]);
    expect(outcome.message).toBe("Wrote digest-2026-11-20.skexample; no provider token stored");
  });

  it("creates a digest file with the counts, and tags it digest", async () => {
    const { deps, sent } = fakes({ stored: null });
    await runDigest("run-1", deps);
    const file = sent.find((s) => s.path.startsWith("/data/files"));
    expect(file?.body?.text).toContain("Run run-1");
    expect(file?.body?.text).toContain("Example files: 5");
    expect(file?.body?.text).toContain("Notes: 5, 2 pinned");
    const record = sent.find((s) => s.path === "/data/records");
    expect(record?.body?.json).toMatchObject({ fileName: "digest-2026-11-20.skexample" });
    expect(sent.at(-1)).toEqual({
      method: "POST",
      path: "/data/labels",
      body: { json: { labels: [{ recordId: "REC9", key: "tag", value: "digest" }] } },
    });
  });

  it("counts pinned notes with a where on pinned", async () => {
    const { deps, sent } = fakes({ stored: null });
    await runDigest("run-1", deps);
    const counts = sent.filter((s) => s.method === "GET").map((s) => decodeURIComponent(s.path));
    expect(counts).toEqual([
      '/data/records?aggregate={"n":{"fn":"count"}}',
      '/app-data/db/notes?aggregate={"n":{"fn":"count"}}',
      '/app-data/db/notes?where={"pinned":{"is":true}}&aggregate={"n":{"fn":"count"}}',
    ]);
  });

  it("fails without writing anything when the vault refuses the read", async () => {
    const { deps, sent, puts } = fakes({ stored: SECRET, readFails: true });
    const outcome = await runDigest("run-1", deps);
    expect(outcome).toEqual({ status: 502, message: "Reading the provider token failed: refused" });
    expect(puts).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("keeps the rotated token when a later write fails, and reports the refusal", async () => {
    const { deps, puts } = fakes({ stored: SECRET, failOn: "/data/files" });
    const outcome = await runDigest("run-1", deps);
    expect(puts).toEqual([["provider-token", `${SECRET}#1`]]);
    expect(outcome).toEqual({ status: 502, message: "The data server answered 403: refused" });
  });
});

/** Files the keywords fakes serve, by record id: text, or null when the fetch fails. */
type Texts = Record<string, string | null>;

function keywordFakes(opts: { texts: Texts; more?: boolean; unsigned?: string[] }): {
  deps: KeywordsDeps;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const ids = Object.keys(opts.texts);
  const deps: KeywordsDeps = {
    data: async (method, path, body) => {
      sent.push({ method, path, body });
      if (path.startsWith("/data/records?")) {
        return { records: ids.map((id) => ({ id })), nextCursor: opts.more ? "c2" : null };
      }
      if (path === "/data/records/file-urls") {
        const urls: Record<string, { url: string }> = {};
        for (const id of ids) {
          if (!opts.unsigned?.includes(id)) urls[id] = { url: `https://bytes/${id}` };
        }
        return { urls };
      }
      return {};
    },
    fetchText: async (url) => {
      const text = opts.texts[url.slice("https://bytes/".length)];
      if (text === null || text === undefined) {
        throw new DataCallError(404, "A file's text answered 404");
      }
      return text;
    },
  };
  return { deps, sent };
}

describe("a keywords run", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists only unread files, oldest first, one batch at a time", async () => {
    const { deps, sent } = keywordFakes({ texts: {} });
    expect(await runKeywords(deps)).toEqual({ status: 200, message: "No new files" });
    const query = new URL(`https://x${sent[0]!.path}`).searchParams;
    expect(query.get("notLabel")).toBe("example-app/indexed");
    expect(JSON.parse(query.get("order")!)).toEqual([{ col: "created_at", dir: "asc" }]);
    expect(query.get("limit")).toBe(String(KEYWORDS_BATCH));
    expect(sent).toHaveLength(1);
  });

  it("sets each file's keywords exactly, then flags every file it read", async () => {
    const { deps, sent } = keywordFakes({
      texts: { R1: "Flour, flour and water. Salt.", R2: "a b c" },
    });
    const outcome = await runKeywords(deps);
    expect(outcome).toEqual({ status: 200, message: "Read 2 files; none left" });
    expect(sent[1]).toEqual({
      method: "POST",
      path: "/data/records/file-urls",
      body: { json: { ids: ["R1", "R2"] } },
    });
    expect(sent[2]).toEqual({
      method: "POST",
      path: "/data/labels/values",
      body: {
        json: {
          labels: [
            { recordId: "R1", key: "keyword", values: ["flour", "water", "salt"] },
            // A file with no keywords is still read, and its key holds nothing.
            { recordId: "R2", key: "keyword", values: [] },
          ],
        },
      },
    });
    expect(sent[3]).toEqual({
      method: "POST",
      path: "/data/labels",
      body: {
        json: {
          labels: [
            { recordId: "R1", key: "indexed" },
            { recordId: "R2", key: "indexed" },
          ],
        },
      },
    });
  });

  it("says more files remain when the listing has another page", async () => {
    const { deps } = keywordFakes({ texts: { R1: "Kettle" }, more: true });
    expect((await runKeywords(deps)).message).toBe("Read 1 file; more remain for the next run");
  });

  it("leaves a file it could not read unflagged, for the next run", async () => {
    const { deps, sent } = keywordFakes({
      texts: { R1: "Kettle", R2: null, R3: "Moon" },
      unsigned: ["R3"],
    });
    const outcome = await runKeywords(deps);
    expect(outcome).toEqual({
      status: 200,
      message: "Read 1 file; 2 could not be read; none left",
    });
    expect(sent.at(-1)?.body?.json).toEqual({ labels: [{ recordId: "R1", key: "indexed" }] });
  });

  it("leaves a file unflagged when the network fails its fetch, and reads the rest", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/R2")) throw new TypeError("fetch failed");
      return new Response("Kettle");
    });
    const { deps, sent } = keywordFakes({ texts: { R1: "", R2: "" } });
    const outcome = await runKeywords({ ...deps, fetchText });
    expect(outcome).toEqual({
      status: 200,
      message: "Read 1 file; 1 could not be read; none left",
    });
    expect(sent.at(-1)?.body?.json).toEqual({ labels: [{ recordId: "R1", key: "indexed" }] });
  });

  it("writes no labels when it reads no file", async () => {
    const { deps, sent } = keywordFakes({ texts: { R1: null } });
    expect((await runKeywords(deps)).message).toBe("Read 0 files; 1 could not be read; none left");
    expect(sent.map((s) => s.path)).not.toContain("/data/labels");
  });

  it("fails with the data server's reason when a call is refused", async () => {
    const deps: KeywordsDeps = {
      data: async () => {
        throw new DataCallError(403, "The data server answered 403: refused");
      },
      fetchText: async () => "",
    };
    expect(await runKeywords(deps)).toEqual({
      status: 502,
      message: "The data server answered 403: refused",
    });
  });
});
