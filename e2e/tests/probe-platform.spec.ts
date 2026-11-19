/**
 * Tier-2 platform flows against the Probe fixture app.
 *
 * The properties asserted here belong to the platform rather than to any app:
 * the install consent gate shows what the manifest asked for, the daemon route
 * really starts and stops a process, a record one app writes is visible to
 * another and its app-private rows are not, identical bytes dedup, uninstall
 * keeps app data and shared records, Delete data deletes the app data, and a
 * corrupted HMAC secret turns into a refusal the app surfaces.
 *
 * Probe rather than a real application, because none of these claims is about
 * any particular app and core must not assume one exists. Photos asserts the
 * same platform properties through its own UI in the starkeep-apps checkout;
 * this suite is what keeps them covered in a deployment that has no Photos.
 *
 * Serial: each test continues the platform state the previous one produced,
 * mirroring the operator journey install → run → use → uninstall.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  driveCreds,
  eventually,
  solidPng,
  startAppDaemonViaAdmin,
  stopAppDaemonViaAdmin,
  sweepAppRoutes,
} from "@starkeep/e2e";

test.describe.configure({ mode: "serial" });

const adminUrl = () => process.env.E2E_ADMIN_URL!;
const driveUrl = () => process.env.E2E_DRIVE_URL!;
const ldsUrl = () => process.env.E2E_LDS_URL!;
const adminDataDir = () => process.env.E2E_ADMIN_DATA_DIR!;

const NOTE = "a note only Probe can read";

/**
 * The Probe card on the admin Dashboard (Local section).
 *
 * Found by `data-slot="card"`, the attribute every dashboard entry carries
 * through the shared `AppCard`. The selector used to name the card's utility
 * classes, and `a5e276e` restyled the card — `rounded-md border` became
 * `rounded-xl ring-1` — which left this spec hunting an element that had only
 * changed color.
 */
function probeCard(page: Page): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("Probe", { exact: true }) })
    .first();
}

/**
 * Run one of a card's secondary actions.
 *
 * Stop and Uninstall used to be buttons on the card face. `a5e276e` gave every
 * card a single primary button and moved the rest behind an overflow menu, so
 * they are `menuitem`s now — and the menu renders in a portal, outside the
 * card, which is why the item is looked up on the page.
 */
async function cardMenuAction(page: Page, card: Locator, label: string): Promise<void> {
  await card.getByRole("button", { name: /^More actions for / }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

// Written once, re-used for the dedup upload so the bytes are byte-identical.
let fixturePath: string;
const FIXTURE_NAME = "probe-fixture.png";
// Set when the daemon starts; later tests visit the running app.
let probeUrl: string;

test.beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "starkeep-probe-fixtures-"));
  fixturePath = join(dir, FIXTURE_NAME);
  await writeFile(fixturePath, solidPng([40, 120, 200], 8));
});

test("install through the admin consent flow, with the manifest's grants shown", async ({
  page,
}) => {
  await page.goto(adminUrl());
  const card = probeCard(page);
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: /^Install / }).click();

  // The consent dialog must surface what the manifest asked for before
  // anything is written. The card lists the grants too, so scope to the modal.
  const consent = page.locator("div.fixed").filter({ hasText: "Install Probe?" });
  await expect(consent).toBeVisible();
  await expect(consent.getByText("Images", { exact: true })).toBeVisible();
  await expect(consent.getByText("files: read + write")).toBeVisible();
  await expect(consent.getByText("metadata: read + write")).toBeVisible();
  // The type list starts collapsed. Its subtypes appear in the manifest's own
  // order, so this asserts the declared list reached the dialog rather than
  // that some list did.
  await consent.getByRole("button", { name: "3 types" }).click();
  await expect(consent.getByText("png, jpeg, avif")).toBeVisible();

  await page.getByRole("button", { name: "Approve & Install" }).click();
  await expect(card.getByText("Installed", { exact: true })).toBeVisible({ timeout: 60_000 });
});

test("start from the admin UI and reach the app on its allocated port", async ({ page }) => {
  await page.goto(adminUrl());
  const card = probeCard(page);

  await card.getByRole("button", { name: /^Start / }).click();
  const badge = card.getByText(/Running :\d+/);
  await expect(badge).toBeVisible({ timeout: 60_000 });

  const port = (await badge.textContent())!.match(/:(\d+)/)![1];
  probeUrl = `http://localhost:${port}`;

  // The admin status badge is a TCP-level probe; a server can hold its port
  // before it answers HTTP. Wait for a real response before navigating.
  await eventually(
    async () => {
      const res = await fetch(probeUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`probe on ${probeUrl} → ${res.status}`);
    },
    { timeoutMs: 120_000, intervalMs: 1_000 },
  );

  await page.goto(probeUrl);
  await expect(page.getByLabel("Upload")).toBeVisible({ timeout: 60_000 });
});

test("a record one app writes is visible to another; its app-private rows are not", async ({
  page,
}) => {
  await page.goto(probeUrl);
  await page.locator('input[type="file"]').first().setInputFiles(fixturePath);
  await expect(page.getByAltText(FIXTURE_NAME).first()).toBeVisible({ timeout: 60_000 });

  // An app-private row, written through the app's own signing proxy to the
  // app-data plane. Nothing outside Probe is supposed to see it.
  const written = await page.evaluate(async (note) => {
    const res = await fetch("/api/local-data/app-data/db/probe_notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { record_id: "probe-e2e", note } }),
    });
    return res.status;
  }, NOTE);
  expect(written).toBe(200);

  // Drive — a different app, with all-access over shared data — sees the
  // shared record and attributes it to Probe.
  await page.goto(driveUrl());
  const row = page.getByRole("row").filter({ hasText: FIXTURE_NAME }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("probe");

  // …and Drive's all-access over *shared* data is not access to another app's
  // private table. Asserted underneath the UI, because the claim is about the
  // data plane rather than about what Drive chose to render.
  const drive = await driveCreds(ldsUrl());
  const probeNotes = await drive.fetch("/app-data/db/probe_notes");
  expect(probeNotes.status, "Drive read another app's private table").not.toBe(200);
});

test("an analysis read answers from a cached snapshot until a Refresh floor reloads it", async ({
  page,
}) => {
  await page.goto(probeUrl);

  // The page's own fetch, as an app's analysis view would make it.
  const summary = (freshAfter?: number) =>
    page.evaluate(async (floor) => {
      const res = await fetch(
        floor === undefined ? "/api/notes-summary" : `/api/notes-summary?freshAfter=${floor}`,
      );
      return {
        status: res.status,
        body: (await res.json()) as {
          summary: { notes: number; characters: number };
          loadedAt: number;
        },
      };
    }, freshAfter);

  // SQL over the snapshot sees the note the previous test wrote.
  const first = await summary(Date.now());
  expect(first.status).toBe(200);
  expect(first.body.summary).toEqual({ notes: 1, characters: NOTE.length });

  const written = await page.evaluate(async () => {
    const res = await fetch("/api/local-data/app-data/db/probe_notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { record_id: "probe-e2e-2", note: "second" } }),
    });
    return res.status;
  });
  expect(written).toBe(200);

  // Within the five-minute life, the copy answers and says how old it is.
  const cached = await summary();
  expect(cached.body.summary.notes).toBe(1);
  expect(cached.body.loadedAt).toBe(first.body.loadedAt);

  // A Refresh moves the floor to now, and the copy reloads.
  const refreshed = await summary(Date.now());
  expect(refreshed.body.summary).toEqual({
    notes: 2,
    characters: NOTE.length + "second".length,
  });
  expect(refreshed.body.loadedAt).toBeGreaterThan(first.body.loadedAt);
});

test("a local MCP client reaches the app's tools with no token, as loopback trust allows", async () => {
  // On the local surface an outside client such as Claude Code calls the
  // app's delegated route over loopback. The route admits it with full app
  // power and no token, the way the app's own pages are admitted.
  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = await fetch(`${probeUrl.replace(/\/$/, "")}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    return JSON.parse(body.result.content[0]!.text) as { status: number; body: unknown };
  }

  const written = await call("add_note", { recordId: "probe-mcp", note: "from an MCP client" });
  expect(written.status).toBe(200);
  const notes = await call("list_notes");
  expect(notes.status).toBe(200);
  expect(JSON.stringify(notes.body)).toContain("from an MCP client");
});

test("every app-facing data route answers through the app's own proxy", async () => {
  // The tier-3 journey runs the same sweep through the cloud-served proxy.
  // See e2e/src/route-sweep.ts for why both surfaces need it.
  const checked = await sweepAppRoutes(
    {
      surface: "local",
      async send(method, path, json) {
        const res = await fetch(`${probeUrl}/api/local-data${path}`, {
          method,
          ...(json !== undefined
            ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }
            : {}),
        });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // Keep the text.
        }
        return { status: res.status, body };
      },
    },
    {
      appId: "probe",
      // Random colors, so the two records the sweep makes never dedup into the
      // fixture the other steps upload.
      file: {
        type: "image/png",
        contentType: "image/png",
        bytes: () => solidPng([rand(), rand(), rand()], 9),
      },
      labelKey: "tag",
      table: { name: "probe_notes", keyColumn: "record_id", valueColumn: "note" },
      childTable: {
        name: "probe_note_tags",
        keyColumn: "id",
        parentColumn: "note_id",
        valueColumn: "tag",
      },
      publicSharing: true,
      job: "probe-tick",
    },
  );
  expect(checked.length).toBeGreaterThan(20);
});

const rand = () => Math.floor(Math.random() * 256);

test("re-uploading identical bytes dedups at the platform layer", async ({ page }) => {
  await page.goto(probeUrl);
  await expect(page.getByAltText(FIXTURE_NAME).first()).toBeVisible({ timeout: 60_000 });
  const countBefore = await page.getByAltText(FIXTURE_NAME).count();

  await page.locator('input[type="file"]').first().setInputFiles(fixturePath);
  await expect(page.getByRole("status")).toContainText("is already in your library");
  expect(await page.getByAltText(FIXTURE_NAME).count()).toBe(countBefore);
});

test("the page says background jobs need a cloud, on the local surface", async ({ page }) => {
  await page.goto(probeUrl);
  await expect(page.locator("#jobs")).toHaveText("Background jobs need a cloud.");
  const run = await fetch(`${probeUrl}/api/jobs/probe-tick/run`, { method: "POST" });
  expect(run.status).toBe(501);
  expect(await run.json()).toEqual({ ok: false, cloudRequired: true });
});

/** Stop Probe and uninstall it through its card and the uninstall dialog. */
async function uninstallProbe(page: Page): Promise<Locator> {
  await page.goto(adminUrl());
  const card = probeCard(page);
  await cardMenuAction(page, card, "Stop");
  await expect(card.getByRole("button", { name: /^Start / })).toBeVisible({ timeout: 60_000 });
  await cardMenuAction(page, card, "Uninstall");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("data stays on this machine");
  await dialog.getByRole("button", { name: "Uninstall" }).click();
  await expect(card.getByRole("button", { name: /^Install / })).toBeVisible({
    timeout: 60_000,
  });
  return card;
}

/** Install Probe from its card, start it, and return the note rows it reads. */
async function reinstallProbe(page: Page, card: Locator): Promise<string> {
  await card.getByRole("button", { name: /^Install / }).click();
  await page.getByRole("button", { name: "Approve & Install" }).click();
  // Exact, because a substring match also finds the "Not installed" badge and
  // passes before the install returns. The install route stops the app's
  // daemon as its last step, so a daemon started early gets that SIGTERM.
  await expect(card.getByText("Installed", { exact: true })).toBeVisible({ timeout: 60_000 });

  const { url } = await startAppDaemonViaAdmin(adminUrl(), "probe");
  probeUrl = url;

  await page.goto(probeUrl);
  // Shared data is visible again through the fresh grant.
  await expect(page.getByAltText(FIXTURE_NAME).first()).toBeVisible({ timeout: 120_000 });
  return page.evaluate(async () => {
    const res = await fetch("/api/local-data/app-data/db/probe_notes");
    return res.ok ? await res.text() : `status ${res.status}`;
  });
}

test("uninstall keeps app data, and shared records survive in Drive", async ({ page }) => {
  const card = await uninstallProbe(page);
  await expect(card.getByText("Data kept", { exact: true })).toBeVisible();

  // The shared record survives the uninstall.
  await page.goto(driveUrl());
  await expect(page.getByRole("row").filter({ hasText: FIXTURE_NAME }).first()).toBeVisible();
});

test("reinstall brings back the kept app-private rows", async ({ page }) => {
  await page.goto(adminUrl());
  const card = probeCard(page);
  await card.getByRole("button", { name: /^Install / }).click();
  // The consent panel says the install reattaches the kept data.
  await expect(page.getByText("This install brings back Probe’s kept data")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  const notes = await reinstallProbe(page, card);
  expect(notes).toContain(NOTE);
});

test("Delete data removes the kept rows, and a reinstall starts empty", async ({ page }) => {
  const card = await uninstallProbe(page);
  await cardMenuAction(page, card, "Delete data…");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("row");
  const remove = dialog.getByRole("button", { name: "Delete data" });
  await expect(remove).toBeDisabled();
  await dialog.getByRole("textbox").fill("probe");
  await remove.click();
  await expect(card.getByText("Data kept", { exact: true })).toBeHidden({ timeout: 30_000 });

  const notes = await reinstallProbe(page, card);
  expect(notes).not.toContain(NOTE);
});

test("a corrupted HMAC secret turns into 401s and a visible error state", async ({ page }) => {
  // Corrupt the persisted secret, then restart so the app's per-process
  // credential cache re-reads the file.
  const credsPath = join(adminDataDir(), "app-creds", "probe.json");
  const creds = JSON.parse(await readFile(credsPath, "utf-8")) as { hmacSecret: string };
  creds.hmacSecret = "corrupted-secret";
  await writeFile(credsPath, JSON.stringify(creds, null, 2));

  await stopAppDaemonViaAdmin(adminUrl(), "probe");
  const { url } = await startAppDaemonViaAdmin(adminUrl(), "probe");
  probeUrl = url;

  // The app's server-side proxy signs with the bad secret; the LDS refuses.
  await eventually(async () => {
    const res = await fetch(`${probeUrl}/api/local-data/data/records`);
    expect(res.status).toBe(401);
  });

  // And the UI surfaces it rather than rendering an empty-but-healthy page.
  await page.goto(probeUrl);
  await expect(page.getByText(/Data server GET .*→ 401/)).toBeVisible({ timeout: 60_000 });
});
