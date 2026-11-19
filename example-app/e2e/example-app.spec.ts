/**
 * The example app on a real platform, driven the way a person would.
 *
 * The spec walks the page's headings top to bottom. Each step clicks a control
 * and checks the visible result, and the Activity table shows every request's
 * status. Steps share state on purpose: the file created first is the one
 * later steps label, annotate, copy and delete.
 *
 * The same steps run on both surfaces (`surface.ts`). Locally the spec
 * installs the app through admin-web and starts it. In the cloud,
 * `cloud-setup.ts` has installed it on the test stack and signed a fresh
 * user in, and the spec opens the page with that user's cookies. A step that
 * holds on one surface only says so and skips on the other.
 */

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { installAppViaAdmin, startAppDaemonViaAdmin } from "@starkeep/e2e";
import { APP_ID, SAMPLE_FILES } from "@example-app/common";
import { SURFACE, cloudRun, enabledCloudRun } from "./surface";

test.describe.configure({ mode: "serial" });
test.skip(
  SURFACE === "cloud" && !cloudRun().enabled,
  "The cloud run needs STARKEEP_AWS_TESTS=1 (e2e-aws/README.md)",
);

/**
 * What a new record's `POST /data/records` answers. The cloud answers 201 for
 * an insert and 200 for a dedup; local-data-server answers 200 for both. Both
 * mark a dedup with `deduped: true` in the body.
 */
const RECORD_CREATED = SURFACE === "cloud" ? 201 : 200;

let page: Page;
const statusLine = () => page.locator("#status");

test.beforeAll(async ({ browser }) => {
  if (SURFACE === "cloud") {
    const run = enabledCloudRun();
    page = await browser.newPage({ storageState: run.storageState });
    await page.goto(run.appUrl);
  } else {
    const adminUrl = process.env.E2E_ADMIN_URL!;
    await installAppViaAdmin(adminUrl, APP_ID);
    const { url } = await startAppDaemonViaAdmin(adminUrl, APP_ID);
    page = await browser.newPage();
    await page.goto(url);
  }
  await expect(statusLine()).toHaveText("Load: done.");
});

test.afterAll(async () => {
  await page?.close();
});

/** Click a button and wait for the page to report the operation done. */
async function click(name: string, what: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(statusLine()).toHaveText(`${what}: done.`);
}

const table = (name: string) => page.getByRole("table", { name, exact: true });
const activity = () => table("Activity");

/**
 * One cell, addressed by the row's text and the column's heading. A whole-row
 * `toContainText("7")` matches a 7 anywhere in the row, such as in a size or
 * an id; a cell matches only its own value.
 */
async function cell(tableName: string, rowText: string, heading: string) {
  const t = table(tableName);
  const headings = (await t.locator("thead th").allTextContents()).map((h) => h.trim());
  const index = headings.indexOf(heading);
  if (index < 0) throw new Error(`table ${tableName} has no column ${heading}`);
  return t.locator("tbody tr").filter({ hasText: rowText }).first().locator("td").nth(index);
}

/** Every cell of one column, top to bottom. */
async function column(tableName: string, heading: string) {
  const t = table(tableName);
  const headings = (await t.locator("thead th").allTextContents()).map((h) => h.trim());
  const index = headings.indexOf(heading);
  if (index < 0) throw new Error(`table ${tableName} has no column ${heading}`);
  return t.locator(`tbody tr td:nth-child(${index + 1})`);
}

/**
 * The status of the newest Activity row with this method and a path matching
 * `path`. The Activity table lists the newest request first.
 */
async function expectLogged(method: string, path: RegExp, status: number): Promise<void> {
  await expect
    .poll(() =>
      activity()
        .locator("tbody tr")
        .evaluateAll(
          (rows, [m, source]) => {
            const re = new RegExp(source as string);
            for (const row of rows) {
              const cells = Array.from(row.querySelectorAll("td"), (td) => td.textContent ?? "");
              if (cells[1] === m && re.test(cells[2] ?? "")) return cells[3];
            }
            return null;
          },
          [method, path.source],
        ),
    )
    .toBe(String(status));
}

/**
 * Whether any Activity row has this method, a path matching `path` and this
 * status. For a step that sends several requests to one path, whose order the
 * step does not fix.
 */
async function expectLoggedAny(method: string, path: RegExp, status: number): Promise<void> {
  await expect
    .poll(() =>
      activity()
        .locator("tbody tr")
        .evaluateAll(
          (rows, [m, source, s]) => {
            const re = new RegExp(source as string);
            return rows.some((row) => {
              const cells = Array.from(row.querySelectorAll("td"), (td) => td.textContent ?? "");
              return cells[1] === m && re.test(cells[2] ?? "") && cells[3] === s;
            });
          },
          [method, path.source, String(status)],
        ),
    )
    .toBe(true);
}

/** What a request sent from the page answered. */
interface Answer {
  status: number;
  body: unknown;
}

/**
 * A data-plane request through the app's signing proxy, sent from the page the
 * way a second tab of the app would send it. Steps use it to change state
 * behind the page's back, or to seed many rows at once. The path is relative
 * to the page, so it reaches the proxy under any mount.
 */
async function viaProxy(
  method: string,
  path: string,
  body?: { json: unknown } | { text: string },
): Promise<Answer> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const init: RequestInit = { method };
      if (body && "json" in body) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(body.json);
      } else if (body) {
        init.headers = { "Content-Type": "text/plain" };
        init.body = body.text;
      }
      const res = await fetch(`api/local-data${path}`, init);
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Keep the text.
      }
      return { status: res.status, body: parsed };
    },
    { method, path, body },
  );
}

/** Store text and register it as an example file, as the page's Create file does. */
async function seedFile(name: string, text: string): Promise<string> {
  const stored = await viaProxy("POST", "/data/files?type=example%2Fplaintext", { text });
  expect(stored.status).toBe(200);
  const { contentHash, sizeBytes } = stored.body as { contentHash: string; sizeBytes: number };
  const made = await viaProxy("POST", "/data/records", {
    json: {
      type: "example/plaintext",
      fileName: name,
      contentType: "text/plain",
      contentHash,
      sizeBytes,
    },
  });
  expect(made.status).toBe(RECORD_CREATED);
  return (made.body as { record: { id: string } }).record.id;
}

/** Write a note the way another tab or client would: a plain upsert. */
async function writeNoteElsewhere(recordId: string, note: string): Promise<void> {
  const res = await viaProxy("POST", "/app-data/db/notes", {
    json: {
      row: { record_id: recordId, note, pinned: false, updated_on: new Date().toISOString() },
    },
  });
  expect(res.status).toBe(200);
}

/** The id of the file the Open panel shows. */
async function openId(): Promise<string> {
  return (await (await cell("Open file", "Id", "Value")).textContent())!;
}

/** The status text a failed operation leaves. */
async function clickExpectingFailure(name: string, message: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(statusLine()).toHaveText(message);
}

/** The body a signed URL answers, fetched outside the page. */
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  expect(res.status, url).toBe(200);
  return res.text();
}

test("Connection: the surface, the session, and a refused write outside the grant", async () => {
  await expect(await cell("Connection", "Surface", "Value")).toHaveText(SURFACE);
  await expect(await cell("Connection", "Session", "Value")).toHaveText(
    SURFACE === "cloud" ? `signed in as ${enabledCloudRun().user.email}` : "none needed locally",
  );
  await click("Run grant check", "Grant check");
  await expect(table("Connection")).toContainText("403 refused, as it should be");
  await expectLogged("POST", /^\/data\/records$/, 403);
});

test("Connection: the platform's consent pages, on the gateway's host", async () => {
  const connect = (await cell("Connection", "Connect page", "Value")).getByRole("link");
  const connections = (await cell("Connection", "Connections page", "Value")).getByRole("link");
  if (SURFACE === "local") {
    await expect(await cell("Connection", "Connect page", "Value")).toHaveText("none locally");
    await expect(await cell("Connection", "Connections page", "Value")).toHaveText("none locally");
    await expect(connect).toHaveCount(0);
    await expect(connections).toHaveCount(0);
    return;
  }
  // The pages answer on the execute-api host, never on the page's own
  // CloudFront origin, where the same paths answer 404.
  const gateway = enabledCloudRun().gatewayUrl.replace(/\/+$/, "");
  await expect(connect).toHaveAttribute("href", `${gateway}/connect?app=${APP_ID}`);
  await expect(connections).toHaveAttribute("href", `${gateway}/connections`);
  const res = await fetch((await connect.getAttribute("href"))!);
  expect(res.status).toBe(200);
});

test("Connection: the app's own JWT-gated route answers", async () => {
  // Locally the route is same-origin and needs no token. In the cloud the
  // gateway's JWT authorizer guards it, so the page first asks its session
  // for a token and sends it as a Bearer credential.
  await click("Call the JWT route", "JWT route");
  await expect(await cell("Connection", "JWT route", "Value")).toHaveText("200, echoed");
  if (SURFACE === "cloud") await expectLogged("GET", /^\/api\/session\/token$/, 200);
  await expectLogged("POST", /^\/api\/echo$/, 200);
});

test("Connection: the local server refuses a non-loopback Host", async () => {
  test.skip(SURFACE !== "local", "A check of the local server; CloudFront fronts the cloud");
  // A DNS-rebinding page reaches 127.0.0.1 under a hostname it controls, so
  // the request arrives with that hostname in `Host`. Node's fetch drops a
  // caller's `Host`, so this asks through node:http, which sends it as given.
  const appUrl = new URL(page.url());
  const statusFor = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: appUrl.hostname,
          port: appUrl.port,
          path: "/starkeep-runtime-config",
          headers: { Host: host },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
  expect(await statusFor(`attacker.example:${appUrl.port}`)).toBe(403);
  expect(await statusFor(`localhost:${appUrl.port}`)).toBe(200);
});

test("Connection: the local server refuses a write from another site", async () => {
  test.skip(
    SURFACE !== "local",
    "A check of the local server; the cloud's session cookies guard it",
  );
  // A page on another site can send a blind `no-cors` POST to 127.0.0.1 with
  // a loopback `Host`, and the proxy would sign it. Only `Sec-Fetch-Site`
  // tells it apart, and node:http sends it as given.
  const appUrl = new URL(page.url());
  const send = (method: string, path: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: appUrl.hostname, port: appUrl.port, method, path, headers },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(method === "POST" ? JSON.stringify({ labels: [] }) : undefined);
    });
  const labels = "/api/local-data/data/labels";
  const plain = { "Content-Type": "text/plain" };
  expect(
    await send("POST", labels, {
      ...plain,
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "no-cors",
    }),
  ).toBe(403);
  expect(
    await send("POST", labels, {
      ...plain,
      "Sec-Fetch-Site": "same-site",
      "Sec-Fetch-Mode": "navigate",
    }),
  ).toBe(403);
  // admin-web's Open link is a same-site GET navigation, and the page opens.
  expect(
    await send("GET", "/", { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate" }),
  ).toBe(200);
  // The page's own requests are same-origin and go through.
  expect(
    await send("GET", "/api/local-data/data/types", {
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
    }),
  ).toBe(200);
});

test("Example files: create one from text, with its counts inline", async () => {
  await page.getByLabel("File name").fill("hello.skexample");
  await page
    .getByLabel("Content", { exact: true })
    .fill("Hello, Starkeep.\nThis file is an example.");
  await click("Create file", "Create file");
  // Two lines and seven words, written with the record.
  await expect(await cell("Example files", "hello.skexample", "Lines")).toHaveText("2");
  await expect(await cell("Example files", "hello.skexample", "Words")).toHaveText("7");
  await expect(await cell("Example files", "hello.skexample", "Bytes")).toHaveText("41");
  await expect(page.getByLabel("File content")).toContainText("Hello, Starkeep.");
  // The Open panel shows the size and both kinds of date. A file made from
  // text has no source file, so the source reported no dates.
  await expect(await cell("Open file", "Size", "Value")).toHaveText("41 bytes");
  await expect(await cell("Open file", "Record created", "Value")).toHaveText(/^\d{4}-\d\d-\d\dT/);
  await expect(await cell("Open file", "Original modified", "Value")).toHaveText("—");
  // The metadata row, read from the record's own metadata route. In the cloud
  // an encoded slash in this route once emptied exactly this row.
  await expect(await cell("Open file", "Metadata", "Value")).toContainText('"word_count":7');
  await expect(await cell("Open file", "Metadata", "Value")).toContainText('"line_count":2');
  await expectLogged("GET", /^\/data\/records\/[^/]+\/metadata\/example$/, 200);
  await expect(table("Types")).toContainText("example/plaintext");
  await expectLogged("POST", /^\/data\/files\?type=example%2Fplaintext$/, 200);
  await expectLogged("POST", /^\/data\/records$/, RECORD_CREATED);
});

test("Example files: upload a file through a presigned URL", async () => {
  await page.getByLabel("Upload a file").setInputFiles({
    name: "uploaded.skexample",
    mimeType: "text/plain",
    buffer: Buffer.from("one\ntwo\nthree\n"),
  });
  await expect(statusLine()).toHaveText("Upload: done.");
  await expect(await cell("Example files", "uploaded.skexample", "Lines")).toHaveText("3");
  await expect(await cell("Example files", "uploaded.skexample", "Words")).toHaveText("3");
  await expectLogged("POST", /^\/files\/presign$/, 200);
  // local-data-server answers a presigned PUT with 204; S3 answers 200.
  await expectLogged("PUT", /^PUT <presigned upload URL>$/, SURFACE === "local" ? 204 : 200);
});

test("Notes: write, delete, pin and unpin a note on the open file", async () => {
  await click("Open hello.skexample", "Open");
  await page.getByLabel("Note", { exact: true }).fill("first note");
  await page.getByLabel("Pinned", { exact: true }).check();
  await click("Save note", "Save note");
  await expect(await cell("Notes", "first note", "Pinned")).toHaveText("yes");
  await expect(await cell("Open file", "Note", "Value")).toHaveText("first note (pinned)");
  await expect(page.getByLabel("Pinned notes")).toHaveText("1");
  await expectLogged("POST", /^\/app-data\/db\/notes$/, 200);

  // The Open panel's Delete note removes the row it read.
  await click("Delete note", "Delete note");
  await expect(table("Notes")).toContainText("Nothing yet.");
  await expect(await cell("Open file", "Note", "Value")).toHaveText("none");
  await expectLogged("DELETE", /^\/app-data\/db\/notes$/, 200);

  await page.getByLabel("Note", { exact: true }).fill("first note");
  await page.getByLabel("Pinned", { exact: true }).check();
  await click("Save note", "Save note");
  await click("Unpin first note", "Pin");
  await expect(await cell("Notes", "first note", "Pinned")).toHaveText("");
  await expect(page.getByLabel("Pinned notes")).toHaveText("0");
  await expectLogged("PATCH", /^\/app-data\/db\/notes$/, 200);
  // The Notes table's write moved the row's stamp, and the Open panel read it
  // again, so an edit from the panel still goes through.
  await page.getByLabel("Note", { exact: true }).fill("first note");
  await click("Save note", "Save note");
  await expect(await cell("Open file", "Note", "Value")).toHaveText("first note");
});

test("Notes: a write from another tab is never silently overwritten", async () => {
  // An edit: the panel read the note, another tab changed it, and the panel's
  // PATCH carries the stamp it read, so the server answers 409 `stale`.
  const helloId = await openId();
  await writeNoteElsewhere(helloId, "written in another tab");
  await page.getByLabel("Note", { exact: true }).fill("first note, edited");
  await clickExpectingFailure(
    "Save note",
    "Save note failed: the note changed since the file was opened; open it again",
  );
  await expectLogged("PATCH", /^\/app-data\/db\/notes$/, 409);
  await clickExpectingFailure(
    "Delete note",
    "Delete note failed: the note changed since the file was opened; open it again",
  );
  await expectLogged("DELETE", /^\/app-data\/db\/notes$/, 409);
  // Opening the file again reads the other tab's note and its stamp.
  await click("Open hello.skexample", "Open");
  await expect(await cell("Open file", "Note", "Value")).toHaveText("written in another tab");
  await page.getByLabel("Note", { exact: true }).fill("first note");
  await click("Save note", "Save note");

  // A new note: the panel saw none, another tab added one, and the panel's
  // POST with `ifAbsent` writes nothing.
  await click("Open uploaded.skexample", "Open");
  await expect(await cell("Open file", "Note", "Value")).toHaveText("none");
  const uploadedId = await openId();
  await writeNoteElsewhere(uploadedId, "50% off_now");
  await page.getByLabel("Note", { exact: true }).fill("from this tab");
  await clickExpectingFailure(
    "Save note",
    "Save note failed: a note was added since the file was opened; open it again",
  );
  await click("Open uploaded.skexample", "Open");
  await expect(await cell("Open file", "Note", "Value")).toHaveText("50% off_now");
});

test("Notes: search by text, prefix, edit date and page", async () => {
  const search = async (text: string, match: "Contains" | "Starts with" = "Contains") => {
    await page.getByLabel("Search", { exact: true }).fill(text);
    await page.getByLabel("Match").selectOption({ label: match });
    await click("Search notes", "Search notes");
  };
  // `%` and `_` are the data's own characters here, not wildcards.
  await search("%");
  await expect(await column("Notes", "Note")).toHaveText(["50% off_now"]);
  await search("_");
  await expect(await column("Notes", "Note")).toHaveText(["50% off_now"]);
  await search("nothing like this");
  await expect(table("Notes")).toContainText("Nothing yet.");
  await search("first");
  await expect(await column("Notes", "Note")).toHaveText(["first note"]);
  await expectLogged("GET", /^\/app-data\/db\/notes\?.*%22like%22/, 200);

  // `prefix` matches the start only.
  await search("note", "Starts with");
  await expect(table("Notes")).toContainText("Nothing yet.");
  await search("first", "Starts with");
  await expect(await column("Notes", "Note")).toHaveText(["first note"]);
  await expectLogged("GET", /^\/app-data\/db\/notes\?.*%22prefix%22/, 200);
  await search("");

  // `gte` on the edit date.
  await page.getByLabel("Edited since").fill("2999-01-01T00:00:00.000Z");
  await click("Search notes", "Search notes");
  await expect(table("Notes")).toContainText("Nothing yet.");
  await expectLogged("GET", /^\/app-data\/db\/notes\?.*%22gte%22/, 200);
  await page.getByLabel("Edited since").fill("2000-01-01T00:00:00.000Z");
  await click("Search notes", "Search notes");
  await expect(await column("Notes", "Note")).toHaveCount(2);
  await page.getByLabel("Edited since").fill("");

  // `in` over the ids of the files the Example files table shows.
  await page.getByLabel("Files", { exact: true }).selectOption({ label: "Files on this page" });
  await click("Search notes", "Search notes");
  await expect(await column("Notes", "Note")).toHaveCount(2);
  await expectLogged("GET", /^\/app-data\/db\/notes\?.*%22in%22/, 200);
  await page.getByLabel("Files", { exact: true }).selectOption({ label: "All files" });

  // The Notes table's own Delete removes a note without opening its file.
  await click("Delete note 50% off_now", "Delete note");
  await expect(await column("Notes", "Note")).toHaveText(["first note"]);
  await click("Search notes", "Search notes");
});

test("Analysis: SQL over a cached snapshot, as of its load time, until a Refresh", async () => {
  // The page loaded the analysis before any note existed, and the snapshot
  // lives five minutes, so the notes the previous steps saved are not in it.
  const asOf = page.getByLabel("Analysis as of");
  await expect(table("Notes per day")).toContainText("Nothing yet.");
  const before = Number(await asOf.getAttribute("data-loaded-at"));
  expect(before).toBeGreaterThan(0);

  // A Refresh sends a floor of now, and the server reloads the copy.
  await click("Refresh analysis", "Refresh analysis");
  await expect(await column("Notes per day", "Notes")).toHaveText(["1"]);
  await expect(await column("Notes per day", "Pinned")).toHaveText(["0"]);
  await expect(await column("Notes per day", "Average length")).toHaveText([
    String("first note".length),
  ]);
  expect(Number(await asOf.getAttribute("data-loaded-at"))).toBeGreaterThan(before);
  await expectLogged("GET", /^\/api\/notes-by-day\?/, 200);
});

test("Labels: add, retract one, set exactly, count and retract tags", async () => {
  await click("Open hello.skexample", "Open");
  await page.getByLabel("Tags", { exact: true }).fill("draft, idea");
  await page.getByLabel("Reviewed").check();
  await click("Add tags", "Add tags");
  await expect(await column("Tag counts", "Tag")).toHaveText(["draft", "idea"]);
  await expect(await column("Tag counts", "Files")).toHaveText(["1", "1"]);
  await expect(await cell("Example files", "hello.skexample", "Labels")).toContainText(
    "example-app/reviewed",
  );
  // The Open panel reads the single-record route, which must name each
  // label's key just as the list does.
  const openLabels = await cell("Open file", "Labels", "Value");
  await expect(openLabels).toContainText("example-app/tag=draft");
  await expect(openLabels).toContainText("example-app/tag=idea");
  await expect(openLabels).toContainText("example-app/reviewed");
  await expect(openLabels).not.toContainText("undefined");
  await expectLogged("POST", /^\/data\/labels$/, 200);

  // One value of a set-valued key, leaving the others.
  await page.getByLabel("Tags", { exact: true }).fill("draft");
  await click("Retract these tags", "Retract tags");
  await expect(await column("Tag counts", "Tag")).toHaveText(["idea"]);
  await expect(await cell("Open file", "Labels", "Value")).not.toContainText("tag=draft");
  await expectLogged("POST", /^\/data\/labels\/retract$/, 200);

  // Exactly these values: one added, one kept, and then one removed.
  await page.getByLabel("Tags", { exact: true }).fill("idea, final");
  await click("Set tags exactly", "Set tags");
  expect((await (await column("Tag counts", "Tag")).allTextContents()).sort()).toEqual([
    "final",
    "idea",
  ]);
  await page.getByLabel("Tags", { exact: true }).fill("idea");
  await click("Set tags exactly", "Set tags");
  await expect(await column("Tag counts", "Tag")).toHaveText(["idea"]);
  await expectLogged("POST", /^\/data\/labels\/values$/, 200);

  await click("Retract reviewed", "Retract reviewed");
  await expect(await cell("Example files", "hello.skexample", "Labels")).not.toContainText(
    "example-app/reviewed",
  );
  await expect(await cell("Declared label keys", "derived", "App")).toHaveText(APP_ID);
});

test("Example files: filter by tag, then clear it", async () => {
  await page.getByLabel("Show").selectOption("tag");
  await page.getByLabel("Tag", { exact: true }).fill("idea");
  await click("Apply filter", "Filter");
  await expect(await column("Example files", "Name")).toHaveText([/hello\.skexample$/]);
  await expectLogged("GET", /^\/data\/records\?.*label=/, 200);
  await page.getByLabel("Show").selectOption("all");
  await click("Apply filter", "Filter");
  await expect(table("Example files")).toContainText("uploaded.skexample");
  await click("Retract all tags", "Retract all tags");
  await expect(table("Tag counts")).toContainText("Nothing yet.");
});

test("Example files: a derived copy, the copies and originals filters, and file URLs", async () => {
  await click("Copy uppercase hello.skexample", "Copy uppercase");
  await expect(await cell("Example files", "hello-upper.skexample", "Labels")).toHaveText(
    "example-app/derived=uppercase",
  );
  await expect(await cell("Example files", "hello-upper.skexample", "Copy of")).toHaveText("yes");
  await expect(page.getByLabel("File content")).toContainText("HELLO, STARKEEP.");

  // The copies of the open file, by `parent_id`.
  await click("Open hello.skexample", "Open");
  await page.getByLabel("Show").selectOption("children");
  await click("Apply filter", "Filter");
  await expect(await column("Example files", "Name")).toHaveText(["hello-upper.skexample"]);
  await expectLogged("GET", /^\/data\/records\?.*where=%7B%22parent_id%22/, 200);

  await page.getByLabel("Show").selectOption("originals");
  await click("Apply filter", "Filter");
  await expect(table("Example files")).not.toContainText("hello-upper.skexample");
  await expect(await column("Example files", "Name")).toHaveCount(2);
  await expectLogged("GET", /^\/data\/records\?.*notLabel=/, 200);
  await page.getByLabel("Show").selectOption("all");
  await click("Apply filter", "Filter");

  await click("Count files", "Count");
  await expect(page.getByLabel("File count")).toHaveText("3");
  await expectLogged("GET", /^\/data\/records\?.*aggregate=/, 200);
  await click("Fetch URLs for this page", "Fetch URLs");
  await expect(page.getByLabel("URLs fetched")).toHaveText("3 URLs");
  await expectLogged("POST", /^\/data\/records\/file-urls$/, 200);
  // Each URL serves its own file's bytes.
  const urls = page.getByLabel("Fetched URLs");
  const helloUrl = await urls
    .getByRole("link", { name: "hello.skexample", exact: true })
    .getAttribute("href");
  expect(await fetchText(helloUrl!)).toBe("Hello, Starkeep.\nThis file is an example.");
  const upperUrl = await urls
    .getByRole("link", { name: "hello-upper.skexample", exact: true })
    .getAttribute("href");
  expect(await fetchText(upperUrl!)).toBe("HELLO, STARKEEP.\nTHIS FILE IS AN EXAMPLE.");
});

test("Metadata: the category table, its totals, and a recompute that repairs a row", async () => {
  // Largest first: hello and its uppercase copy have seven words, the upload three.
  await expect(await column("Metadata", "Words")).toHaveText(["7", "7", "3"]);
  await expect(await column("Metadata", "Lines")).toHaveText(["2", "2", "3"]);
  await expect(await cell("Metadata totals", "files", "Value")).toHaveText("3");
  await expect(await cell("Metadata totals", "words", "Value")).toHaveText("17");
  await expect(await cell("Metadata totals", "longest", "Value")).toHaveText("3");
  await expectLogged("GET", /^\/data\/metadata\/example\?.*aggregate=/, 200);

  // Wrong counts, written behind the page's back, and then the recompute.
  await click("Open hello.skexample", "Open");
  const id = await openId();
  const wrong = await viaProxy("POST", `/data/records/${id}/metadata`, {
    json: {
      typeId: "example/plaintext",
      metadata: { line_count: 9, word_count: 99, char_count: 999 },
    },
  });
  expect(wrong.status).toBe(200);
  await click("Apply filter", "Filter");
  await expect(await cell("Example files", "hello.skexample", "Words")).toHaveText("99");

  await click("Recompute metadata", "Recompute metadata");
  await expectLogged("POST", /^\/data\/records\/[^/]+\/metadata$/, 200);
  await expect(await cell("Example files", "hello.skexample", "Words")).toHaveText("7");
  await expect(await cell("Example files", "hello.skexample", "Lines")).toHaveText("2");
  await expect(await cell("Open file", "Metadata", "Value")).toContainText('"word_count":7');
  await expect(await cell("Metadata totals", "words", "Value")).toHaveText("17");
});

test("Note exports: save the notes as a private file, list, open, fetch and delete it", async () => {
  await click("Save export", "Save export");
  const row = table("Note exports").getByRole("row").filter({ hasText: "exports/notes-" });
  await expect(row).toHaveCount(1);
  await expectLogged("POST", /^\/app-data\/files\/exports\/notes-[^/]+\.json\/record$/, 200);
  await expectLogged("GET", /^\/app-data\/files\?prefix=exports%2F$/, 200);
  const subKey = (await row.getByRole("cell").first().textContent())!;
  await click(`Open ${subKey}`, "Open export");
  await expect(page.locator("pre").filter({ hasText: "first note" })).toBeVisible();
  await click("Get export URLs", "Get export URLs");
  await expect(page.getByText("1 URLs fetched in one call.")).toBeVisible();
  await expectLogged("POST", /^\/app-data\/file-urls$/, 200);
  // The URL serves the export itself.
  const href = await page
    .getByLabel("Export URLs")
    .getByRole("link", { name: subKey, exact: true })
    .getAttribute("href");
  const exported = JSON.parse(await fetchText(href!)) as { notes: { text: string }[] };
  expect(exported.notes.map((n) => n.text)).toEqual(["first note"]);
  await click(`Delete ${subKey}`, "Delete export");
  await expect(table("Note exports")).toContainText("Nothing yet.");
  await expectLogged("DELETE", /^\/app-data\/files\/exports\//, 200);
});

test("Note exports: the list reads every page", async () => {
  // A page of the listing holds 30 files, so 31 exports take two requests.
  const count = 31;
  const made = await page.evaluate(async (count) => {
    const statuses: number[] = [];
    for (let i = 0; i < count; i++) {
      const bytes = new TextEncoder().encode(JSON.stringify({ notes: [], i }));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const contentHash = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const name = `notes-seeded-${String(i).padStart(2, "0")}.json`;
      const subKey = `exports/${name}`;
      const presign = await fetch("api/local-data/app-data/files/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subKey, contentType: "application/json", contentHash }),
      });
      const { url, checksumSha256 } = (await presign.json()) as {
        url: string;
        checksumSha256?: string;
      };
      const put = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(checksumSha256 ? { "x-amz-checksum-sha256": checksumSha256 } : {}),
        },
        body: bytes,
      });
      const record = await fetch(`api/local-data/app-data/files/${subKey}/record`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentHash,
          mimeType: "application/json",
          sizeBytes: bytes.byteLength,
          originalFilename: name,
        }),
      });
      statuses.push(presign.status, put.ok ? 200 : put.status, record.status);
    }
    return statuses;
  }, count);
  expect(made.every((s) => s === 200)).toBe(true);
  await click("Save export", "Save export");
  await expect(table("Note exports").getByRole("row").filter({ hasText: "exports/" })).toHaveCount(
    count + 1,
  );
  await expectLogged("GET", /^\/app-data\/files\?prefix=exports%2F&page_token=/, 200);
});

test("Deleted: a deletion appears in the reconcile, restores, and takes derived copies and notes", async () => {
  await click("Delete uploaded.skexample", "Delete");
  await expectLogged("DELETE", /^\/data\/records\/[^/?]+$/, 200);
  // The Notes steps deleted this file's note, so the note delete finds a
  // deleted row and answers 200 with `skipped: "deleted"`.
  await expectLogged("DELETE", /^\/app-data\/db\/notes$/, 200);
  await expect(table("Example files")).not.toContainText("uploaded.skexample");
  await expect(table("Deleted files")).toContainText("uploaded.skexample");
  await expectLogged("GET", /^\/data\/records\?deleted=only&/, 200);
  await click("Restore uploaded.skexample", "Restore");
  await expect(table("Example files")).toContainText("uploaded.skexample");
  await expectLogged("POST", /^\/data\/records\/[^/]+\/restore$/, 200);

  // Deleting a record deletes its derived copies with it, and the open copy
  // goes with it: the panel empties, and the page reports the delete as done.
  await click("Open hello-upper.skexample", "Open");
  await click("Delete hello.skexample", "Delete");
  await expect(page.getByText("Select a file with its Open button.")).toBeVisible();
  await expect(table("Example files")).not.toContainText("hello.skexample");
  await expect(table("Example files")).not.toContainText("hello-upper.skexample");
  await expect(table("Deleted files")).toContainText("hello.skexample");
  await expect(table("Deleted files")).toContainText("hello-upper.skexample");
  // The note on hello.skexample goes with its file. The app deletes it from
  // the ids the record delete answered. The derived copy never had a note, so
  // its note delete answers 404 with a missing row, and the app counts the
  // delete as done. The two requests run in the order of the ids the server
  // answered.
  await expect(table("Notes")).not.toContainText("first note");
  await expectLoggedAny("DELETE", /^\/app-data\/db\/notes$/, 404);
  await expectLoggedAny("DELETE", /^\/app-data\/db\/notes$/, 200);

  // With nothing open, "Copies of the selected file" has no file to ask about.
  await page.getByLabel("Show").selectOption("children");
  await clickExpectingFailure("Apply filter", "Filter failed: select a file first");
  await page.getByLabel("Show").selectOption("all");
  await click("Apply filter", "Filter");

  // A restore lifts the cascade the delete wrote: the copy comes back too.
  // The note does not: the app deleted it, and the platform knows nothing of
  // the app's own rows.
  await click("Restore hello.skexample", "Restore");
  await expect(table("Example files")).toContainText("hello-upper.skexample");
  await expect(await cell("Example files", "hello-upper.skexample", "Copy of")).toHaveText("yes");
  await expect(table("Deleted files")).not.toContainText("hello");
  await click("Open hello.skexample", "Open");
  await expect(await cell("Open file", "Note", "Value")).toHaveText("none");

  // The platform's default window, read through GET /data/trash.
  await expect(await cell("Trash", "Retention window", "Value")).toHaveText("30 days");
  await expectLogged("GET", /^\/data\/trash$/, 200);
});

test("Example files: page through more files than one page holds", async () => {
  // Three files exist; nine more make twelve, and a page holds ten.
  for (let i = 1; i <= 9; i++) await seedFile(`paged-${i}.skexample`, `page ${i}`);
  await click("Apply filter", "Filter");
  await expect(await column("Example files", "Name")).toHaveCount(10);
  await click("Next page", "Next page");
  await expect(await column("Example files", "Name")).toHaveCount(2);
  await expectLogged("GET", /^\/data\/records\?.*page_token=/, 200);
  // The oldest two, created first, end the list.
  await expect(table("Example files")).toContainText("hello.skexample");
  await expect(table("Example files")).toContainText("uploaded.skexample");
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toHaveCount(0);
  await click("Previous page", "Previous page");
  await expect(await column("Example files", "Name")).toHaveCount(10);
  await expect(table("Example files")).toContainText("paged-9.skexample");
});

test("Notes: a search reads past the first page", async () => {
  // Rows per request are 25, so 26 unpinned notes take a second page.
  for (let i = 1; i <= 26; i++) {
    await writeNoteElsewhere(`paging-${String(i).padStart(2, "0")}`, `paging note ${i}`);
  }
  await page.getByLabel("Search", { exact: true }).fill("paging note");
  await click("Search notes", "Search notes");
  await expect(await column("Notes", "Note")).toHaveCount(26);
  await expectLogged("GET", /^\/app-data\/db\/notes\?.*page_token=/, 200);
  await page.getByLabel("Search", { exact: true }).fill("");
});

test("Connection: the cloud address public links live under", async () => {
  test.skip(SURFACE !== "local", "In the cloud the page's own origin is the address");
  // A computer signed in to a cloud records its address in config.json, in
  // the platform's state directory, which this stack keeps in a throwaway
  // folder. The app reads it on each request.
  const configPath = join(process.env.E2E_ADMIN_DATA_DIR!, "config.json");
  const original = await readFile(configPath, "utf8");
  const address = () =>
    page.evaluate(async () => (await (await fetch("api/cloud-address")).json()) as unknown);
  try {
    expect(await address()).toEqual({ url: null });
    await writeFile(
      configPath,
      JSON.stringify({ ...JSON.parse(original), publicBaseUrl: "https://cloud.example.test/" }),
    );
    expect(await address()).toEqual({ url: "https://cloud.example.test" });
  } finally {
    await writeFile(configPath, original);
  }
});

test("Public links: unavailable without a cloud", async () => {
  test.skip(SURFACE !== "local", "The cloud project creates, opens and revokes a link instead");
  // The tier-2 stack has no cloud, and public links live only in the cloud.
  await expect(page.getByText("Public links are unavailable here")).toBeVisible();
});

test("Public links: create one to a file, open it signed out, and revoke it", async () => {
  test.skip(SURFACE !== "cloud", "Public links live only in the cloud");
  // The paging step left the first page showing, where the newest file is.
  await click("Share paged-9.skexample", "Share");
  await expectLogged("POST", /^\/data\/public-shares$/, 201);
  const href = await (await cell("Public links", "paged-9.skexample", "Link"))
    .getByRole("link")
    .getAttribute("href");
  expect(href).toMatch(
    new RegExp(`^${new URL(page.url()).origin}/public-shares/[A-Za-z0-9_-]{22}/file/`),
  );
  // Anyone with the link sees the file, with no cookie: Node's fetch sends none.
  expect(await fetchText(href!)).toBe("page 9");

  await click("Revoke paged-9.skexample", "Revoke");
  await expectLogged("DELETE", /^\/data\/public-shares\/[^/]+$/, 200);
  await expect(table("Public links")).toContainText("Nothing yet.");
  // CloudFront may serve the link's redirect from its cache for up to a
  // minute (PUBLIC_SHARE_CACHE_SECONDS); after that the link is gone.
  await expect
    .poll(async () => (await fetch(href!, { redirect: "manual" })).status, {
      timeout: 120_000,
      intervals: [5_000],
    })
    .toBe(404);
});

test("MCP: an outside client creates, lists, reads, tags, notes and trashes files", async () => {
  // An outside client such as Claude Code calls the app's MCP route. On the
  // local surface loopback trust admits it with no token, as the app's own
  // pages are admitted. In the cloud it sends a `readwrite` delegation token,
  // which the gateway's delegated authorizer checks before the app sees the
  // request. Near the end, because the file and tag it adds would change the
  // counts the tests above assert.
  const mcp = new URL("mcp", page.url()).href;
  const token = SURFACE === "cloud" ? enabledCloudRun().delegationTokens.readwrite : null;
  let nextId = 0;
  async function send(body: string, bearer: string | null = token) {
    return fetch(mcp, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body,
    });
  }
  async function rpcRaw(method: string, params: Record<string, unknown> = {}) {
    const res = await send(JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }));
    expect(res.status).toBe(200);
    return (await res.json()) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
  }
  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const body = await rpcRaw(method, params);
    expect(body.error).toBeUndefined();
    return body.result!;
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    return (await rpc("tools/call", { name, arguments: args })) as {
      content: { text: string }[];
      isError: boolean;
    };
  }
  async function tool(name: string, args: Record<string, unknown> = {}) {
    const result = await call(name, args);
    expect(result.isError, result.content[0]!.text).toBe(false);
    return result.content[0]!.text;
  }

  expect(await rpc("initialize", { protocolVersion: "2025-06-18" })).toMatchObject({
    capabilities: { tools: {} },
  });
  const notified = await send(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  expect(notified.status).toBe(202);
  expect(await rpc("ping")).toEqual({});
  const tools = (await rpc("tools/list")) as { tools: { name: string }[] };
  expect(tools.tools.map((t) => t.name)).toEqual([
    "list_files",
    "read_file",
    "tag_file",
    "list_notes",
    "write_note",
    "delete_note",
    "create_file",
    "trash_file",
  ]);

  const created = JSON.parse(
    await tool("create_file", { name: "from-mcp", text: "Written by an MCP client." }),
  ) as { id: string; name: string; tags: string[]; metrics: Record<string, number> };
  expect(created.name).toBe("from-mcp.skexample");
  expect(created.tags).toEqual([]);
  expect(await tool("read_file", { recordId: created.id })).toBe("Written by an MCP client.");

  await tool("tag_file", { recordId: created.id, tag: "mcp" });
  const tagged = JSON.parse(await tool("list_files", { tag: "mcp" })) as {
    id: string;
    tags: string[];
    metrics: Record<string, number>;
  }[];
  expect(tagged.map((f) => f.id)).toEqual([created.id]);
  expect(tagged[0]!.tags).toEqual(["mcp"]);
  expect(tagged[0]!.metrics).toMatchObject({ line_count: 1, word_count: 5, char_count: 25 });

  await tool("write_note", { recordId: created.id, text: "an MCP note" });
  expect(await tool("list_notes")).toContain("an MCP note");
  await tool("delete_note", { recordId: created.id });
  expect(await tool("list_notes")).not.toContain("an MCP note");

  // The errors a client must be able to tell apart.
  expect(await call("tag_file", { recordId: created.id })).toEqual({
    content: [{ type: "text", text: '"tag" is required' }],
    isError: true,
  });
  expect((await rpcRaw("tools/call", { name: "no_such_tool" })).error?.code).toBe(-32602);
  expect((await rpcRaw("resources/list")).error?.code).toBe(-32601);
  const malformed = await send("{not json");
  expect(((await malformed.json()) as { error: { code: number } }).error.code).toBe(-32700);

  // The Trash, where the page's Deleted heading finds the file.
  expect(await tool("trash_file", { recordId: created.id })).toBe("Moved to the Trash.");
  expect(JSON.parse(await tool("list_files", { tag: "mcp" }))).toEqual([]);
  await click("Reconcile", "Reconcile");
  await expect(table("Deleted files")).toContainText("from-mcp.skexample");
  const gone = await call("read_file", { recordId: created.id });
  expect(gone.isError).toBe(true);
  expect(gone.content[0]!.text).toMatch(/^The data server answered 404/);
});

test("MCP: the gateway refuses a call with no token, and a read token cannot write", async () => {
  test.skip(SURFACE !== "cloud", "Locally loopback trust admits every caller");
  const mcp = new URL("mcp", page.url()).href;
  async function callTool(bearer: string | null, name: string, args: Record<string, unknown>) {
    const res = await fetch(mcp, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return {
      status: res.status,
      result:
        res.status === 200
          ? ((await res.json()) as { result: { content: { text: string }[]; isError: boolean } })
              .result
          : null,
    };
  }
  expect((await callTool(null, "list_files", {})).status).toBe(401);

  const read = enabledCloudRun().delegationTokens.read;
  const listed = await callTool(read, "list_files", {});
  expect(listed.result?.isError, listed.result?.content[0]?.text).toBe(false);
  // The token's mode narrows the app's grants: a `read` token reads and
  // labels, and the data server refuses its row writes.
  const hello = (
    JSON.parse(listed.result!.content[0]!.text) as { id: string; name: string }[]
  ).find((f) => f.name === "hello.skexample")!;
  const write = await callTool(read, "write_note", { recordId: hello.id, text: "not allowed" });
  expect(write.result?.isError).toBe(true);
  expect(write.result?.content[0]?.text).toMatch(/^The data server answered 403/);
});

test("Sample data: load the set once, and a second load adds nothing", async () => {
  await page.getByLabel("Show").selectOption("all");
  await click("Apply filter", "Filter");
  await click("Load sample data", "Load sample data");
  await expect(page.getByLabel("Sample data")).toHaveText(
    `${SAMPLE_FILES.length + 1} sample files, their notes and three collections.`,
  );
  // The newest page holds the sample files and the derived copy, each with
  // the sample flag beside its own labels.
  for (const file of SAMPLE_FILES) {
    await expect(await cell("Example files", file.name, "Labels")).toContainText(
      "example-app/sample",
    );
  }
  await expect(await cell("Example files", "poem-upper.skexample", "Labels")).toContainText(
    "example-app/derived=uppercase",
  );
  await expect(await cell("Tag counts", "kitchen", "Files")).toHaveText("2");
  await expect(await cell("Notes", "Check the pantry before shopping", "Pinned")).toHaveText("yes");
  await expectLoggedAny("GET", /^\/data\/records\?label=example-app%2Fsample&limit=1$/, 200);

  await click("Load sample data", "Load sample data");
  await expect(page.getByLabel("Sample data")).toHaveText(
    "Sample files already exist; delete them to load the set again.",
  );
});

test("Collections: a count over a left join, and contents joined to notes and other collections", async () => {
  await expect(await cell("Collections", "Recipes", "Files")).toHaveText("3");
  await expect(await cell("Collections", "Reading list", "Files")).toHaveText("3");
  await expect(await cell("Collections", "Old drafts", "Files")).toHaveText("3");
  await expect(await cell("Collections", "Old drafts", "Archived")).toHaveText("yes");
  await expectLogged("GET", /^\/app-data\/db\/collections\?join=.*&aggregate=/, 200);

  await click("Show Recipes", "Show collection");
  await expect(await column("Collection contents", "File")).toHaveCount(3);
  await expect(await cell("Collection contents", "grocery-list.skexample", "Note")).toHaveText(
    "Check the pantry before shopping",
  );
  await expect(await cell("Collection contents", "bread.skexample", "Note")).toHaveText("none");
  await expect(await cell("Collection contents", "pancakes.skexample", "Also in")).toHaveText(
    "Reading list",
  );
  // Bread's only other collection is archived. The archive filter sits in
  // the join's `on`, so bread stays listed with an empty "Also in".
  await expect(await cell("Collection contents", "bread.skexample", "Also in")).toHaveText("");
  await expectLogged("GET", /^\/app-data\/db\/collection_items\?.*join=/, 200);

  await click("Unarchive Old drafts", "Unarchive collection");
  await expect(await cell("Collection contents", "bread.skexample", "Also in")).toHaveText(
    "Old drafts",
  );
  await click("Archive Old drafts", "Archive collection");
  await expect(await cell("Collection contents", "bread.skexample", "Also in")).toHaveText("");
});

test("Collections: an empty one counts 0, and the open file joins and leaves collections", async () => {
  await page.getByLabel("Collection name").fill("Favorites");
  await click("Create collection", "Create collection");
  await expect(await cell("Collections", "Favorites", "Files")).toHaveText("0");
  await expect(table("Collection contents")).toContainText("Favorites holds no files.");

  // `exists` lists the collections that hold the file. `not_exists` offers
  // the unarchived ones that do not, so the archived Old drafts is not offered.
  await click("Open haiku.skexample", "Open");
  await expect(await cell("Open file", "Collections", "Value")).toHaveText("Old drafts (archived)");
  await expect(page.getByRole("button", { name: "Add to Old drafts", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remove from Old drafts", exact: true }),
  ).toBeVisible();
  await expectLogged(
    "GET",
    /^\/app-data\/db\/collections\?where=%7B%22archived%22.*not_exists/,
    200,
  );

  await click("Add to Favorites", "Add to collection");
  await expect(await cell("Open file", "Collections", "Value")).toHaveText(
    "Favorites, Old drafts (archived)",
  );
  await expect(await cell("Collections", "Favorites", "Files")).toHaveText("1");
  await expect(await cell("Collection contents", "haiku.skexample", "Also in")).toHaveText("");

  await click("Remove haiku.skexample from Favorites", "Remove from collection");
  await expect(await cell("Collections", "Favorites", "Files")).toHaveText("0");
  await expect(await cell("Open file", "Collections", "Value")).toHaveText("Old drafts (archived)");

  await page.getByLabel("Collection name").fill("Keepers");
  await click("Rename Favorites", "Rename collection");
  await expect(await cell("Collections", "Keepers", "Files")).toHaveText("0");
  await click("Delete collection Keepers", "Delete collection");
  await expect(table("Collections")).not.toContainText("Keepers");
});

test("Notes: filter by a collection, by no collection, and by files off the page", async () => {
  const files = page.getByLabel("Files", { exact: true });
  await files.selectOption({ label: "Files in Reading list" });
  await click("Search notes", "Search notes");
  // None is pinned, so newest first: one, three and seven days old.
  await expect(await column("Notes", "Note")).toHaveText([
    "Double the batch for guests",
    "Ask the library about the sequel",
    "Second stanza needs work",
  ]);
  await expectLogged("GET", /^\/app-data\/db\/notes\?.*%22in%22%3A%7B%22table%22/, 200);

  await files.selectOption({ label: "Files in no collection" });
  await click("Search notes", "Search notes");
  await expect(table("Notes")).toContainText("Send the summary on Friday");
  await expect(table("Notes")).not.toContainText("Check the pantry before shopping");
  await expectLogged("GET", /^\/app-data\/db\/notes\?.*%22not_in%22%3A%7B%22table%22/, 200);

  // The newest page holds every sample file, so no sample note is off it.
  await files.selectOption({ label: "Files not on this page" });
  await click("Search notes", "Search notes");
  for (const file of SAMPLE_FILES) {
    if (file.note) await expect(table("Notes")).not.toContainText(file.note.text);
  }
  await expectLogged("GET", /^\/app-data\/db\/notes\?.*%22not_in%22%3A%5B/, 200);

  await files.selectOption({ label: "All files" });
  await click("Search notes", "Search notes");
});

test("Collections: deleting a file takes it out of every collection", async () => {
  await click("Delete bread.skexample", "Delete");
  await expect(await cell("Collections", "Recipes", "Files")).toHaveText("2");
  await expect(await cell("Collections", "Old drafts", "Files")).toHaveText("2");
  await expectLoggedAny("DELETE", /^\/app-data\/db\/collection_items$/, 200);
});

test("Connection: refresh the session, then sign out", async () => {
  test.skip(SURFACE !== "cloud", "The local surface has no session");
  const context = page.context();
  const hasCookie = async (name: string) => (await context.cookies()).some((c) => c.name === name);
  // Drop the short-lived token, as its expiry would; the refresh mints another
  // from the session cookie.
  await context.clearCookies({ name: "sk_token" });
  await click("Refresh session", "Refresh session");
  await expectLogged("POST", /^\/api\/session\/refresh$/, 200);
  expect(await hasCookie("sk_token")).toBe(true);

  // Sign out clears the app's cookies, ends the managed login session and
  // returns to the app, which now shows its sign-in page.
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  expect(await hasCookie("sk_session")).toBe(false);
  // The managed login session ended too, so a new sign-in asks for the email
  // again rather than returning straight to the app.
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\.amazoncognito\.com\//);
  await expect(page.locator('input[name="username"], input[type="email"]').first()).toBeVisible();
});

test("Open file: a live file whose bytes are missing reports the error, and a deleted one empties the panel", async () => {
  test.skip(SURFACE !== "local", "Only the local surface lets the suite remove a file's bytes");
  // A file whose bytes this computer lost. The record is live, so the panel
  // must report the failed read rather than treat the file as deleted.
  const text = `bytes gone ${Date.now()}`;
  const id = await seedFile("bytes-gone.skexample", text);
  const objects = join(process.env.E2E_LDS_DIR!, "objects");
  let removed = 0;
  for (const entry of await readdir(objects, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path, "utf8")) === text) {
      await rm(path);
      removed += 1;
    }
  }
  expect(removed).toBe(1);
  await click("Apply filter", "Filter");
  await clickExpectingFailure(
    "Open bytes-gone.skexample",
    "Open failed: File not on this node, and this node does not sync with a cloud",
  );
  await expectLogged("GET", /^\/data\/records\/[^/]+\/file-url$/, 404);
  await expect(page.getByText("Select a file with its Open button.")).not.toBeVisible();

  // The same file deleted from another tab: the next redraw of the panel
  // finds no record and empties it.
  expect((await viaProxy("DELETE", `/data/records/${id}`)).status).toBe(200);
  await click("Pin paging note 1", "Pin");
  await expect(page.getByText("Select a file with its Open button.")).toBeVisible();
  await expectLogged("GET", /^\/data\/records\/[^/?]+\?include=labels$/, 404);
});
