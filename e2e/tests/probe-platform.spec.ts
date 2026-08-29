/**
 * Tier-2 platform flows against the Probe fixture app.
 *
 * The properties asserted here belong to the platform rather than to any app:
 * the install consent gate shows what the manifest asked for, the daemon route
 * really starts and stops a process, a record one app writes is visible to
 * another and its app-private rows are not, identical bytes dedup, uninstall
 * drops app data and keeps shared records, and a corrupted HMAC secret turns
 * into a refusal the app surfaces.
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
} from "@starkeep/e2e";

test.describe.configure({ mode: "serial" });

const adminUrl = () => process.env.E2E_ADMIN_URL!;
const driveUrl = () => process.env.E2E_DRIVE_URL!;
const ldsUrl = () => process.env.E2E_LDS_URL!;
const adminDataDir = () => process.env.E2E_ADMIN_DATA_DIR!;

const NOTE = "a note only Probe can read";

/** The Probe card on the admin Dashboard (Local section). */
function probeCard(page: Page): Locator {
  return page
    .locator("div.rounded-md.border")
    .filter({ has: page.getByText("Probe", { exact: true }) })
    .first();
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

  await card.getByRole("button", { name: "Install", exact: true }).click();

  // The consent dialog must surface what the manifest asked for before
  // anything is written. The card lists the grants too, so scope to the modal.
  const consent = page.locator("div.fixed").filter({ hasText: "Install Probe?" });
  await expect(consent).toBeVisible();
  // The manifest's own order — the dialog renders `types.join(", ")`, so this
  // asserts the declared list reached the dialog rather than that some list did.
  await expect(consent.getByText("image/png, image/jpeg")).toBeVisible();
  await expect(consent.getByText("records: read + write")).toBeVisible();
  await expect(consent.getByText("metadata: read + write")).toBeVisible();

  await page.getByRole("button", { name: "Approve & Install" }).click();
  await expect(card.getByText("Installed")).toBeVisible({ timeout: 60_000 });
});

test("start from the admin UI and reach the app on its allocated port", async ({ page }) => {
  await page.goto(adminUrl());
  const card = probeCard(page);

  await card.getByRole("button", { name: "Start" }).click();
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

test("re-uploading identical bytes dedups at the platform layer", async ({ page }) => {
  await page.goto(probeUrl);
  await expect(page.getByAltText(FIXTURE_NAME).first()).toBeVisible({ timeout: 60_000 });
  const countBefore = await page.getByAltText(FIXTURE_NAME).count();

  await page.locator('input[type="file"]').first().setInputFiles(fixturePath);
  await expect(page.getByRole("status")).toContainText("is already in your library");
  expect(await page.getByAltText(FIXTURE_NAME).count()).toBe(countBefore);
});

test("uninstall: app data is gone, shared records survive in Drive", async ({ page }) => {
  await page.goto(adminUrl());
  const card = probeCard(page);
  await card.getByRole("button", { name: "Stop" }).click();
  await expect(card.getByRole("button", { name: "Start" })).toBeVisible({ timeout: 60_000 });

  page.on("dialog", (dialog) => void dialog.accept());
  await card.getByRole("button", { name: "Uninstall" }).click();
  await expect(card.getByRole("button", { name: "Install", exact: true })).toBeVisible({
    timeout: 60_000,
  });

  // The shared record survives the uninstall.
  await page.goto(driveUrl());
  await expect(page.getByRole("row").filter({ hasText: FIXTURE_NAME }).first()).toBeVisible();
});

test("reinstall re-exposes shared records; app-private rows are gone", async ({ page }) => {
  await page.goto(adminUrl());
  const card = probeCard(page);
  await card.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByRole("button", { name: "Approve & Install" }).click();
  await expect(card.getByText("Installed")).toBeVisible({ timeout: 60_000 });

  const { url } = await startAppDaemonViaAdmin(adminUrl(), "probe");
  probeUrl = url;

  await page.goto(probeUrl);
  // Shared data is visible again through the fresh grant…
  await expect(page.getByAltText(FIXTURE_NAME).first()).toBeVisible({ timeout: 120_000 });

  // …but the note lived in the app's own table, which uninstall dropped.
  const notes = await page.evaluate(async () => {
    const res = await fetch("/api/local-data/app-data/db/probe_notes");
    return res.ok ? await res.text() : `status ${res.status}`;
  });
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
