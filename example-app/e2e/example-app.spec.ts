/**
 * The example app on a real local platform, driven the way a person would.
 *
 * The spec installs the app through admin-web, starts it, and walks the page's
 * headings top to bottom. Each step clicks a control and checks the visible
 * result, and the Activity table shows every request's status. Steps share
 * state on purpose: the file created first is the one later steps label,
 * annotate, copy and delete.
 */

import http from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { installAppViaAdmin, startAppDaemonViaAdmin } from "@starkeep/e2e";
import { APP_ID } from "@example-app/common";

test.describe.configure({ mode: "serial" });

let page: Page;
const statusLine = () => page.locator("#status");

test.beforeAll(async ({ browser }) => {
  const adminUrl = process.env.E2E_ADMIN_URL!;
  await installAppViaAdmin(adminUrl, APP_ID);
  const { url } = await startAppDaemonViaAdmin(adminUrl, APP_ID);
  page = await browser.newPage();
  await page.goto(url);
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

test("Connection: the local surface, and a refused write outside the grant", async () => {
  await expect(table("Connection")).toContainText("local");
  await click("Run grant check", "Grant check");
  await expect(table("Connection")).toContainText("403 refused, as it should be");
  await expectLogged("POST", /^\/data\/records$/, 403);
});

test("Connection: the app's own JWT-gated route answers", async () => {
  // Locally the route is same-origin and needs no token. In the cloud the
  // gateway's JWT authorizer guards it, and only a cloud run can check that;
  // the example has no tier-3 suite yet.
  await click("Call the JWT route", "JWT route");
  await expect(await cell("Connection", "JWT route", "Value")).toHaveText("200, echoed");
  await expectLogged("POST", /^\/api\/echo$/, 200);
});

test("Connection: the local server refuses a non-loopback Host", async () => {
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
  await expect(table("Types")).toContainText("example/plaintext");
  await expectLogged("POST", /^\/data\/files\?type=example%2Fplaintext$/, 200);
  await expectLogged("POST", /^\/data\/records$/, 200);
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
  await expectLogged("PUT", /^PUT <presigned upload URL>$/, 204);
});

test("Notes: write, pin and search a note on the open file", async () => {
  await click("Open hello.skexample", "Open");
  await page.getByLabel("Note", { exact: true }).fill("first note");
  await page.getByLabel("Pinned", { exact: true }).check();
  await click("Save note", "Save note");
  await expect(await cell("Notes", "first note", "Pinned")).toHaveText("yes");
  await expect(page.getByLabel("Pinned notes")).toHaveText("1");
  await expectLogged("POST", /^\/app-data\/db\/notes$/, 200);
  await click("Unpin first note", "Pin");
  await expect(await cell("Notes", "first note", "Pinned")).toHaveText("");
  await expect(page.getByLabel("Pinned notes")).toHaveText("0");
  await expectLogged("PATCH", /^\/app-data\/db\/notes$/, 200);
  await page.getByLabel("Search", { exact: true }).fill("nothing like this");
  await click("Search notes", "Search notes");
  await expect(table("Notes")).toContainText("Nothing yet.");
  await page.getByLabel("Search", { exact: true }).fill("first");
  await click("Search notes", "Search notes");
  await expect(await column("Notes", "Note")).toHaveText(["first note"]);
  await expectLogged("GET", /^\/app-data\/db\/notes\?/, 200);
});

test("Labels: add, set exactly, count and retract tags", async () => {
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

  await page.getByLabel("Tags", { exact: true }).fill("idea");
  await click("Set tags exactly", "Set tags");
  await expect(await column("Tag counts", "Tag")).toHaveText(["idea"]);
  await expectLogged("POST", /^\/data\/labels\/values$/, 200);

  await click("Retract reviewed", "Retract reviewed");
  await expect(await cell("Example files", "hello.skexample", "Labels")).not.toContainText(
    "example-app/reviewed",
  );
  await expectLogged("POST", /^\/data\/labels\/retract$/, 200);
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

test("Example files: a derived copy, and the originals-only filter", async () => {
  await click("Copy uppercase hello.skexample", "Copy uppercase");
  await expect(await cell("Example files", "hello-upper.skexample", "Labels")).toHaveText(
    "example-app/derived=uppercase",
  );
  await expect(await cell("Example files", "hello-upper.skexample", "Copy of")).toHaveText("yes");
  await expect(page.getByLabel("File content")).toContainText("HELLO, STARKEEP.");

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
});

test("Metadata: the category table and its totals", async () => {
  // Largest first: hello and its uppercase copy have seven words, the upload three.
  await expect(await column("Metadata", "Words")).toHaveText(["7", "7", "3"]);
  await expect(await column("Metadata", "Lines")).toHaveText(["2", "2", "3"]);
  await expect(await cell("Metadata totals", "files", "Value")).toHaveText("3");
  await expect(await cell("Metadata totals", "words", "Value")).toHaveText("17");
  await expect(await cell("Metadata totals", "longest", "Value")).toHaveText("3");
  await click("Open hello.skexample", "Open");
  await click("Recompute metadata", "Recompute metadata");
  await expectLogged("POST", /^\/data\/records\/[^/]+\/metadata$/, 200);
  // The recomputed counts are the counts the file was created with.
  await expect(await cell("Example files", "hello.skexample", "Words")).toHaveText("7");
});

test("Note exports: save the notes as a private file, list, open and delete it", async () => {
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
  await click(`Delete ${subKey}`, "Delete export");
  await expect(table("Note exports")).toContainText("Nothing yet.");
  await expectLogged("DELETE", /^\/app-data\/files\/exports\//, 200);
});

test("Deleted: a deletion appears in the reconcile, restores, and takes derived copies and notes", async () => {
  await click("Delete uploaded.skexample", "Delete");
  await expectLogged("DELETE", /^\/data\/records\/[^/?]+$/, 200);
  // The file carries no note, so the note delete answers 404 with a missing
  // row, and the app counts the delete as done.
  await expectLogged("DELETE", /^\/app-data\/db\/notes$/, 404);
  await expect(table("Example files")).not.toContainText("uploaded.skexample");
  await expect(table("Deleted files")).toContainText("uploaded.skexample");
  await expectLogged("GET", /^\/data\/records\?deleted=only&/, 200);
  await click("Restore uploaded.skexample", "Restore");
  await expect(table("Example files")).toContainText("uploaded.skexample");
  await expectLogged("POST", /^\/data\/records\/[^/]+\/restore$/, 200);

  // Deleting a record deletes its derived copies with it.
  await click("Delete hello.skexample", "Delete");
  await expect(table("Example files")).not.toContainText("hello.skexample");
  await expect(table("Example files")).not.toContainText("hello-upper.skexample");
  await expect(table("Deleted files")).toContainText("hello.skexample");
  await expect(table("Deleted files")).toContainText("hello-upper.skexample");
  // The note on hello.skexample goes with its file. The app deletes it from
  // the ids the record delete answered. The derived copy has no note, so its
  // note delete answers 404, and the two requests run in the order of the ids.
  await expect(table("Notes")).not.toContainText("first note");
  await expectLoggedAny("DELETE", /^\/app-data\/db\/notes$/, 200);

  // The platform's default window, read through GET /data/trash.
  await expect(await cell("Trash", "Retention window", "Value")).toHaveText("30 days");
  await expectLogged("GET", /^\/data\/trash$/, 200);
});

test("Public links: unavailable without a cloud", async () => {
  // The tier-2 stack has no cloud, and public links live only in the cloud.
  // No suite yet creates, opens or revokes one of the example's links.
  await expect(page.getByText("Public links are unavailable here")).toBeVisible();
});

test("MCP: a local client creates, lists, reads, tags and notes files over loopback", async () => {
  // An outside client such as Claude Code calls the app's MCP route. On the
  // local surface loopback trust admits it with no token, as the app's own
  // pages are admitted; in the cloud it would send a delegation token. Last,
  // because the file and tag it adds would change the counts the tests above
  // assert.
  const mcp = `${new URL(page.url()).origin}/mcp`;
  let nextId = 0;
  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const res = await fetch(mcp, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: Record<string, unknown> }).result;
  }
  async function tool(name: string, args: Record<string, unknown> = {}) {
    const result = (await rpc("tools/call", { name, arguments: args })) as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError, result.content[0]!.text).toBe(false);
    return result.content[0]!.text;
  }

  expect(await rpc("initialize", { protocolVersion: "2025-06-18" })).toMatchObject({
    capabilities: { tools: {} },
  });
  const tools = (await rpc("tools/list")) as { tools: { name: string }[] };
  expect(tools.tools.map((t) => t.name)).toContain("read_file");

  const created = JSON.parse(
    await tool("create_file", { name: "from-mcp", text: "Written by an MCP client." }),
  ) as { id: string; name: string };
  expect(created.name).toBe("from-mcp.skexample");
  expect(await tool("read_file", { recordId: created.id })).toBe("Written by an MCP client.");

  await tool("tag_file", { recordId: created.id, tag: "mcp" });
  const tagged = JSON.parse(await tool("list_files", { tag: "mcp" })) as { id: string }[];
  expect(tagged.map((f) => f.id)).toEqual([created.id]);

  await tool("write_note", { recordId: created.id, text: "an MCP note" });
  expect(await tool("list_notes")).toContain("an MCP note");
  await tool("delete_note", { recordId: created.id });
  expect(await tool("list_notes")).not.toContain("an MCP note");
});
