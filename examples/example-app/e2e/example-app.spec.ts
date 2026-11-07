/**
 * The example app on a real local platform, driven the way a person would.
 *
 * The spec installs the app through admin-web, starts it, and walks the page's
 * headings top to bottom. Each step clicks a control and checks the visible
 * result, and the Activity table shows every request's status. Steps share
 * state on purpose: the file created first is the one later steps label,
 * annotate, copy and delete.
 */

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

test("Connection: the local surface, and a refused write outside the grant", async () => {
  await expect(table("Connection")).toContainText("local");
  await click("Run grant check", "Grant check");
  await expect(table("Connection")).toContainText("403 refused, as it should be");
  await expect(
    activity().getByRole("row").filter({ hasText: "/data/records" }).first(),
  ).toContainText("403");
});

test("Example files: create one from text, with its counts inline", async () => {
  await page.getByLabel("File name").fill("hello.skexample");
  await page
    .getByLabel("Content", { exact: true })
    .fill("Hello, Starkeep.\nThis file is an example.");
  await click("Create file", "Create file");
  const row = table("Example files").getByRole("row").filter({ hasText: "hello.skexample" });
  // Two lines and seven words, written with the record.
  await expect(row).toContainText("2");
  await expect(row).toContainText("7");
  await expect(page.getByLabel("File content")).toContainText("Hello, Starkeep.");
  await expect(table("Types")).toContainText("example/plaintext");
});

test("Example files: upload a file through a presigned URL", async () => {
  await page.getByLabel("Upload a file").setInputFiles({
    name: "uploaded.skexample",
    mimeType: "text/plain",
    buffer: Buffer.from("one\ntwo\nthree\n"),
  });
  await expect(statusLine()).toHaveText("Upload: done.");
  await expect(table("Example files")).toContainText("uploaded.skexample");
  await expect(activity()).toContainText("PUT <presigned upload URL>");
});

test("Notes: write, pin and search a note on the open file", async () => {
  await click("Open hello.skexample", "Open");
  await page.getByLabel("Note", { exact: true }).fill("first note");
  await page.getByLabel("Pinned", { exact: true }).check();
  await click("Save note", "Save note");
  await expect(table("Notes")).toContainText("first note");
  await expect(page.getByLabel("Pinned notes")).toHaveText("1");
  await click("Unpin first note", "Pin");
  await expect(page.getByLabel("Pinned notes")).toHaveText("0");
  await page.getByLabel("Search", { exact: true }).fill("nothing like this");
  await click("Search notes", "Search notes");
  await expect(table("Notes")).toContainText("Nothing yet.");
  await page.getByLabel("Search", { exact: true }).fill("first");
  await click("Search notes", "Search notes");
  await expect(table("Notes")).toContainText("first note");
});

test("Labels: add, set exactly, count and retract tags", async () => {
  await click("Open hello.skexample", "Open");
  await page.getByLabel("Tags", { exact: true }).fill("draft, idea");
  await page.getByLabel("Reviewed").check();
  await click("Add tags", "Add tags");
  await expect(table("Tag counts")).toContainText("draft");
  await expect(table("Tag counts")).toContainText("idea");
  await expect(table("Example files")).toContainText("example-app/reviewed");

  await page.getByLabel("Tags", { exact: true }).fill("idea");
  await click("Set tags exactly", "Set tags");
  await expect(table("Tag counts")).not.toContainText("draft");
  await expect(table("Tag counts")).toContainText("idea");

  await click("Retract reviewed", "Retract reviewed");
  await expect(table("Example files")).not.toContainText("example-app/reviewed");
  await expect(table("Declared label keys")).toContainText("derived");
});

test("Example files: filter by tag, then clear it", async () => {
  await page.getByLabel("Show").selectOption("tag");
  await page.getByLabel("Tag", { exact: true }).fill("idea");
  await click("Apply filter", "Filter");
  await expect(table("Example files")).toContainText("hello.skexample");
  await expect(table("Example files")).not.toContainText("uploaded.skexample");
  await page.getByLabel("Show").selectOption("all");
  await click("Apply filter", "Filter");
  await expect(table("Example files")).toContainText("uploaded.skexample");
  await click("Retract all tags", "Retract all tags");
  await expect(table("Tag counts")).toContainText("Nothing yet.");
});

test("Example files: a derived copy, and the originals-only filter", async () => {
  await click("Copy uppercase hello.skexample", "Copy uppercase");
  const copy = table("Example files").getByRole("row").filter({ hasText: "hello-upper.skexample" });
  await expect(copy).toContainText("example-app/derived=uppercase");
  await expect(page.getByLabel("File content")).toContainText("HELLO, STARKEEP.");

  await page.getByLabel("Show").selectOption("originals");
  await click("Apply filter", "Filter");
  await expect(table("Example files")).not.toContainText("hello-upper.skexample");
  await page.getByLabel("Show").selectOption("all");
  await click("Apply filter", "Filter");

  await click("Count files", "Count");
  await expect(page.getByLabel("File count")).toHaveText("3");
  await click("Fetch URLs for this page", "Fetch URLs");
  await expect(page.getByLabel("URLs fetched")).toHaveText("3 URLs");
});

test("Metadata: the category table and its totals", async () => {
  await expect(table("Metadata")).toContainText("7");
  // Two seven-word files and one three-word file.
  await expect(table("Metadata totals")).toContainText("17");
  await click("Open hello.skexample", "Open");
  await click("Recompute metadata", "Recompute metadata");
  await expect(activity()).toContainText("/metadata");
});

test("Snapshots: save the notes as a private file, list, open and delete it", async () => {
  await click("Save snapshot", "Save snapshot");
  const row = table("Snapshots").getByRole("row").filter({ hasText: "snapshots/notes-" });
  await expect(row).toHaveCount(1);
  const subKey = (await row.getByRole("cell").first().textContent())!;
  await click(`Open ${subKey}`, "Open snapshot");
  await expect(page.locator("pre").filter({ hasText: "first note" })).toBeVisible();
  await click("Get snapshot URLs", "Get snapshot URLs");
  await expect(page.getByText("1 URLs fetched in one call.")).toBeVisible();
  await click(`Delete ${subKey}`, "Delete snapshot");
  await expect(table("Snapshots")).toContainText("Nothing yet.");
});

test("Example files: replace content, and the note follows the new record", async () => {
  await page.getByLabel("Content", { exact: true }).fill("Replaced.");
  await click("Replace hello.skexample", "Replace");
  await expect(page.getByLabel("File content")).toContainText("Replaced.");
  await expect(table("Open file")).toContainText("first note");
  await expect(table("Notes").getByRole("row").filter({ hasText: "first note" })).toHaveCount(1);
  // Deleting the old record deleted its derived copy with it.
  await expect(table("Example files")).not.toContainText("hello-upper.skexample");
  await expect(table("Deleted files")).toContainText("hello-upper.skexample");
});

test("Deleted: a deletion appears in the reconcile, and restores", async () => {
  await click("Delete uploaded.skexample", "Delete");
  await expect(table("Example files")).not.toContainText("uploaded.skexample");
  await expect(table("Deleted files")).toContainText("uploaded.skexample");
  await click("Restore uploaded.skexample", "Restore");
  await expect(table("Example files")).toContainText("uploaded.skexample");
  await expect(table("Trash")).toContainText("Retention window");
});

test("Public links: unavailable without a cloud", async () => {
  // The tier-2 stack has no cloud, and public links live only in the cloud.
  // The cloud's tier-3 run covers creating, opening and revoking one.
  await expect(page.getByText("Public links are unavailable here")).toBeVisible();
});
