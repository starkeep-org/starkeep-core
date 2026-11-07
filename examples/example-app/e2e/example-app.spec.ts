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

test("Connection: the local surface, and a refused write outside the grant", async () => {
  await expect(table("Connection")).toContainText("local");
  await click("Run grant check", "Grant check");
  await expect(table("Connection")).toContainText("403 refused, as it should be");
  await expectLogged("POST", /^\/data\/records$/, 403);
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

test("Snapshots: save the notes as a private file, list, open and delete it", async () => {
  await click("Save snapshot", "Save snapshot");
  const row = table("Snapshots").getByRole("row").filter({ hasText: "snapshots/notes-" });
  await expect(row).toHaveCount(1);
  await expectLogged("POST", /^\/app-data\/files\/snapshots\/notes-[^/]+\.json\/record$/, 200);
  await expectLogged("GET", /^\/app-data\/files\?prefix=snapshots%2F$/, 200);
  const subKey = (await row.getByRole("cell").first().textContent())!;
  await click(`Open ${subKey}`, "Open snapshot");
  await expect(page.locator("pre").filter({ hasText: "first note" })).toBeVisible();
  await click("Get snapshot URLs", "Get snapshot URLs");
  await expect(page.getByText("1 URLs fetched in one call.")).toBeVisible();
  await expectLogged("POST", /^\/app-data\/file-urls$/, 200);
  await click(`Delete ${subKey}`, "Delete snapshot");
  await expect(table("Snapshots")).toContainText("Nothing yet.");
  await expectLogged("DELETE", /^\/app-data\/files\/snapshots\//, 200);
});

test("Deleted: a deletion appears in the reconcile, restores, and takes derived copies", async () => {
  await click("Delete uploaded.skexample", "Delete");
  await expectLogged("DELETE", /^\/data\/records\/[^/?]+$/, 200);
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

  // The platform's default window, read through GET /data/trash.
  await expect(await cell("Trash", "Retention window", "Value")).toHaveText("30 days");
  await expectLogged("GET", /^\/data\/trash$/, 200);
});

test("Public links: unavailable without a cloud", async () => {
  // The tier-2 stack has no cloud, and public links live only in the cloud.
  // No suite yet creates, opens or revokes one of the example's links.
  await expect(page.getByText("Public links are unavailable here")).toBeVisible();
});
