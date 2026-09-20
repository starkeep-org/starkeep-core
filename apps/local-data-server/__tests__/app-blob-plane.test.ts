/**
 * The app-private blob plane — what an app may say about its own bytes.
 *
 * The platform stopped deciding. An app namespace carries one advisory ceiling,
 * the eviction pass skips it, and a sync round applies an app's rows without
 * pulling its blobs. Everything below is the surface that leaves the app able to
 * act on that: read what this node holds, note an open, let bytes go without
 * letting the file go, and get them back.
 *
 * **The refusal is the case that matters.** The eviction pass used to be what
 * stood between a budget and a last copy, and it no longer runs here — so the
 * durability rule moved onto the drop, reading each app's `regenerable`
 * declaration. An app that says its blobs can be made again may drop its last
 * copy; an app that says nothing may not, and that is what protects a body of
 * recordings nothing can regenerate.
 *
 * Proven against a test app declaring the same bit rather than against Memo.
 * Memo's decks are the one body of app-specific data in the system nothing can
 * rebuild, they are sensitive besides, and a drop is the operation in this file
 * that deletes bytes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { installApp, putAppFile, testAppManifest, type InstalledApp } from "./helpers.js";

const GB = 1024 ** 3;

let server: LocalDataServer;
/** Declares `files: true` — the short spelling of "not re-derivable". */
let precious: InstalledApp;
/** Declares `files: { regenerable: true }` — Photos' shape. */
let derived: InstalledApp;

/**
 * A budget deliberately below what either app holds, so "reported and not
 * deleted" is distinguishable from "nothing was over anything".
 */
const TIGHT_BUDGET = 8;

beforeAll(async () => {
  server = await startLocalDataServer({
    config: {
      retention: {
        platform: {
          rows: { "original:image": { prefetch: true, share: 1 } },
          fallback: { prefetch: true, share: 1 },
          budgetBytes: 10 * GB,
        },
        apps: {
          testapp: { budgetBytes: TIGHT_BUDGET },
          derived: { budgetBytes: TIGHT_BUDGET },
        },
        appFallback: { budgetBytes: GB },
      },
    },
  });
  precious = await installApp(server, testAppManifest());
  derived = await installApp(
    server,
    testAppManifest({
      id: "derived",
      name: "Derived",
      infraRequirements: {
        appSpecificSyncable: {
          files: { regenerable: true },
          tables: [
            {
              name: "notes",
              columns: [{ name: "note_id", type: "text", primaryKey: true, notNull: true }],
            },
          ],
        },
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await server.stop();
});

interface ResidencyPage {
  budgetBytes: number | null;
  heldBytes: number;
  entries: Array<{
    subKey: string;
    sizeBytes: number;
    resident: boolean;
    lastOpenedAtMs: number | null;
  }>;
  nextCursor: string | null;
}

const residency = async (app: InstalledApp): Promise<ResidencyPage> => {
  const res = await app.fetch("/app-data/residency");
  expect(res.status).toBe(200);
  return (await res.json()) as ResidencyPage;
};

const entryFor = (page: ResidencyPage, subKey: string) =>
  page.entries.find((e) => e.subKey === subKey);

const drop = (app: InstalledApp, subKey: string) =>
  app.fetch(`/app-data/files/${subKey}/blob`, { method: "DELETE" });

/** Whether the bytes are still readable through the ordinary file route. */
async function bytesReadable(app: InstalledApp, subKey: string): Promise<boolean> {
  const res = await app.fetch(`/app-data/files/${subKey}`);
  if (!res.ok) return false;
  const { url } = (await res.json()) as { url: string };
  return (await fetch(url)).status === 200;
}

describe("reading what this node holds", () => {
  it("reports the app's ceiling and what it is holding against it", async () => {
    await putAppFile(precious, "held/one.bin", "0123456789");
    const page = await residency(precious);

    expect(page.budgetBytes).toBe(TIGHT_BUDGET);
    expect(page.heldBytes).toBeGreaterThanOrEqual(10);
    const entry = entryFor(page, "held/one.bin");
    expect(entry).toMatchObject({ sizeBytes: 10, resident: true });
  });

  /**
   * The claim the advisory budget rests on, from the app's side.
   *
   * The app is over its ceiling by a factor of several and everything it wrote
   * is still here. Nothing deletes an app's bytes, because nothing else can tell
   * which of them are disposable.
   */
  it("leaves an app over its budget holding everything it wrote", async () => {
    await putAppFile(precious, "held/two.bin", "0123456789");
    const page = await residency(precious);

    expect(page.heldBytes).toBeGreaterThan(page.budgetBytes!);
    expect(await bytesReadable(precious, "held/one.bin")).toBe(true);
    expect(await bytesReadable(precious, "held/two.bin")).toBe(true);
  });

  it("keeps one app's plane out of another's", async () => {
    await putAppFile(derived, "held/only-mine.bin", "xyz");
    const page = await residency(precious);
    expect(entryFor(page, "held/only-mine.bin")).toBeUndefined();
  });
});

describe("asking about blobs by name", () => {
  /**
   * The read path's question, which is the opposite of the listing's.
   *
   * A page of records about to be painted knows exactly which sub-keys it is
   * about, and paging a plane of three hundred thousand renditions to learn the
   * state of forty is the wrong shape by five orders of magnitude.
   */
  const lookup = async (app: InstalledApp, subKeys: string[]) => {
    const res = await app.fetch("/app-data/residency/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subKeys }),
    });
    return { status: res.status, body: (await res.json()) as { entries?: ResidencyPage["entries"]; error?: string } };
  };

  it("answers for the keys it was given and no others", async () => {
    await putAppFile(precious, "named/one.bin", "0123456789");
    await putAppFile(precious, "named/two.bin", "01234");

    const { status, body } = await lookup(precious, ["named/one.bin"]);

    expect(status).toBe(200);
    expect(body.entries).toEqual([
      { subKey: "named/one.bin", sizeBytes: 10, resident: true, lastOpenedAtMs: null },
    ]);
  });

  // Absence from the answer is absence of the file. A caller reading presence
  // off the result must never be handed a fabricated row for a key nothing has
  // recorded.
  it("omits a key this node knows nothing about", async () => {
    const { body } = await lookup(precious, ["named/one.bin", "never/written.bin"]);
    expect(body.entries!.map((e) => e.subKey)).toEqual(["named/one.bin"]);
  });

  it("reports a blob whose bytes have been dropped as not resident", async () => {
    await putAppFile(derived, "named/droppable.bin", "0123456789");
    expect((await drop(derived, "named/droppable.bin")).status).toBe(200);

    const { body } = await lookup(derived, ["named/droppable.bin"]);
    expect(body.entries![0]).toMatchObject({ subKey: "named/droppable.bin", resident: false });
  });

  it("keeps one app's plane out of another's", async () => {
    const { body } = await lookup(precious, ["named/droppable.bin"]);
    expect(body.entries).toEqual([]);
  });

  it("refuses a request that names nothing, and one that names too much", async () => {
    expect((await lookup(precious, [])).status).toBe(400);
    const tooMany = Array.from({ length: 501 }, (_, i) => `k${i}`);
    expect((await lookup(precious, tooMany)).status).toBe(400);
  });
});

describe("noting an open", () => {
  it("records the open against the blob it names", async () => {
    await putAppFile(precious, "touched.bin", "abc");
    expect(entryFor(await residency(precious), "touched.bin")!.lastOpenedAtMs).toBeNull();

    const res = await precious.fetch("/app-data/files/touched.bin/touch", { method: "POST" });
    expect(res.status).toBe(200);

    const opened = entryFor(await residency(precious), "touched.bin")!.lastOpenedAtMs;
    expect(opened).not.toBeNull();
    expect(opened).toBeLessThanOrEqual(Date.now());
  });

  it("refuses a subKey the app has no file row for", async () => {
    const res = await precious.fetch("/app-data/files/never-written.bin/touch", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});

describe("dropping bytes and keeping the file", () => {
  /**
   * The refusal, and the reason it is worth a test of its own.
   *
   * This node has no cloud configured, so there is no peer to ask and therefore
   * no evidence that a second copy exists. An app that has not declared its
   * blobs re-derivable is refused on exactly that: not "you may not", but "this
   * node cannot see anywhere else these bytes are".
   */
  it("refuses to drop the last copy of a blob the app has not called re-derivable", async () => {
    await putAppFile(precious, "irreplaceable.bin", "the only copy");
    const res = await drop(precious, "irreplaceable.bin");

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ dropped: false, reason: "not-durable" });
    expect(await bytesReadable(precious, "irreplaceable.bin")).toBe(true);
  });

  it("drops the last copy of a blob the app called re-derivable", async () => {
    await putAppFile(derived, "rendition.bin", "make me again");
    const res = await drop(derived, "rendition.bin");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dropped: true, reason: "dropped" });
    expect(await bytesReadable(derived, "rendition.bin")).toBe(false);
  });

  /**
   * What `deleteFile` cannot express, and the whole reason this operation
   * exists.
   *
   * A delete tombstones the row and the tombstone travels, so an app reclaiming
   * disk on one machine would lose the file on every machine. After a drop the
   * file is still a file: `statFile` answers, the residency page still lists it,
   * and only `resident` has changed.
   */
  it("keeps the file row, and reports the blob as no longer resident", async () => {
    await putAppFile(derived, "still-a-file.bin", "bytes");
    await drop(derived, "still-a-file.bin");

    // The row answers, which a tombstone would not: `fileUrl` reads the index
    // and returns null for a deleted file. So the file is still a file and only
    // the bytes behind it are gone.
    const url = await derived.fetch("/app-data/files/still-a-file.bin");
    expect(url.status).toBe(200);

    const entry = entryFor(await residency(derived), "still-a-file.bin");
    expect(entry).toBeDefined();
    expect(entry!.resident).toBe(false);
  });

  /**
   * The other half of "keeps the file": a delete is still a delete.
   *
   * If a drop and a delete were indistinguishable from here, the operation
   * would not be worth having — the point is a node giving up disk without
   * every other node losing the file.
   */
  it("still lets a delete take the file away entirely", async () => {
    await putAppFile(derived, "really-deleted.bin", "bytes");
    const res = await derived.fetch("/app-data/files/really-deleted.bin", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await derived.fetch("/app-data/files/really-deleted.bin")).status).toBe(404);
  });

  it("reports a second drop as nothing to drop rather than failing", async () => {
    await putAppFile(derived, "dropped-twice.bin", "bytes");
    expect((await drop(derived, "dropped-twice.bin")).status).toBe(200);

    const again = await drop(derived, "dropped-twice.bin");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ dropped: false, reason: "not-held" });
  });

  it("refuses a subKey the app has no file row for", async () => {
    expect((await drop(precious, "never-written.bin")).status).toBe(400);
  });
});

describe("fetching bytes back", () => {
  /**
   * A node with no cloud has no engine and therefore nowhere to fetch from.
   *
   * 503 rather than 404: the request is well-formed, the file exists, and the
   * answer is about this node's connectivity rather than about the blob. A
   * caller reading `unavailable` knows to try again later; one reading "not
   * found" would conclude the file was gone.
   */
  it("reports no route to the bytes on a node with no cloud configured", async () => {
    await putAppFile(derived, "want-back.bin", "bytes");
    await drop(derived, "want-back.bin");

    const res = await derived.fetch("/app-data/files/want-back.bin/fetch", { method: "POST" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ landed: false, reason: "unavailable" });
  });

  it("refuses a subKey the app has no file row for", async () => {
    const res = await precious.fetch("/app-data/files/never-written.bin/fetch", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});
