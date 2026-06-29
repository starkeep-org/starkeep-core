/**
 * Tier-2 platform flows with photos as the fixture (plan case 7a). The
 * assertions are against platform surfaces — install consent, daemon
 * lifecycle, cross-app visibility, dedup, data-survival semantics, the HMAC
 * contract — not photos' own features (those live in starkeep-apps/photos).
 *
 * Serial: each test continues the platform state the previous one produced,
 * mirroring the real operator journey install → run → use → uninstall.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, solidPng, startAppDaemonViaAdmin, stopAppDaemonViaAdmin } from "@starkeep/e2e";

test.describe.configure({ mode: "serial" });

const adminUrl = () => process.env.E2E_ADMIN_URL!;
const driveUrl = () => process.env.E2E_DRIVE_URL!;
const adminDataDir = () => process.env.E2E_ADMIN_DATA_DIR!;

const CAPTION = "Sunset over the bay";

/** The photos card on the admin Dashboard (Local section). */
function photosCard(page: Page): Locator {
  return page
    .locator("div.rounded-md.border")
    .filter({ has: page.getByText("Photos", { exact: true }) })
    .first();
}

async function openPhotosViewerCaption(page: Page): Promise<Locator> {
  await page.getByAltText("sunset.png").first().click();
  await page.getByRole("button", { name: "Info" }).click();
  const caption = page.getByPlaceholder("Add a caption…");
  await expect(caption).toBeVisible();
  return caption;
}

// Written once; re-used for the dedup upload so the bytes are identical.
let fixturePath: string;
// Set when the daemon starts; later tests visit the running app.
let photosUrl: string;

test.beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "starkeep-e2e-fixtures-"));
  fixturePath = join(dir, "sunset.png");
  await writeFile(fixturePath, solidPng([200, 80, 10], 8));
});

test("install photos through the admin consent flow", async ({ page }) => {
  await page.goto(adminUrl());
  const card = photosCard(page);
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "Install", exact: true }).click();

  // The consent dialog must surface the manifest's requested grants before
  // anything is written. (The card lists the grants too, so scope to the
  // modal overlay.)
  const consent = page.locator("div.fixed").filter({ hasText: "Install Photos?" });
  await expect(consent).toBeVisible();
  await expect(consent.getByText(/image\/jpeg, image\/png/)).toBeVisible();
  await expect(consent.getByText("records: read + write")).toBeVisible();
  await expect(consent.getByText("metadata: read + write")).toBeVisible();

  await page.getByRole("button", { name: "Approve & Install" }).click();
  await expect(card.getByText("Installed")).toBeVisible({ timeout: 60_000 });
});

test("start photos from the admin UI and open it on its allocated port", async ({ page }) => {
  await page.goto(adminUrl());
  const card = photosCard(page);

  await card.getByRole("button", { name: "Start" }).click();
  const badge = card.getByText(/Running :\d+/);
  await expect(badge).toBeVisible({ timeout: 60_000 });

  const port = (await badge.textContent())!.match(/:(\d+)/)![1];
  // localhost, not 127.0.0.1 — see startNextDev in the harness.
  photosUrl = `http://localhost:${port}`;

  // The admin status badge is a TCP-level probe; next dev binds its port
  // before it can answer HTTP. Wait for a real response before navigating.
  await eventually(
    async () => {
      const res = await fetch(photosUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`photos on ${photosUrl} → ${res.status}`);
    },
    { timeoutMs: 120_000, intervalMs: 1_000 },
  );

  await page.goto(photosUrl);
  await expect(page.getByRole("button", { name: "Add Photo" })).toBeVisible({ timeout: 120_000 });
});

test("a photo uploaded in photos appears in Drive; its caption does not", async ({ page }) => {
  await page.goto(photosUrl);
  await page.locator('input[type="file"]').first().setInputFiles(fixturePath);
  await expect(page.getByAltText("sunset.png").first()).toBeVisible({
    timeout: 60_000,
  });

  // Caption it (app-specific data, saved on blur).
  const caption = await openPhotosViewerCaption(page);
  const saved = page.waitForResponse(
    (r) => r.url().includes("/api/photos/captions/") && r.request().method() === "PUT",
  );
  await caption.fill(CAPTION);
  await caption.blur();
  expect((await saved).ok()).toBe(true);

  // Drive sees the shared record, attributed to photos — but not the
  // app-specific caption.
  await page.goto(driveUrl());
  const row = page.getByRole("row").filter({ hasText: "sunset.png" }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("photos");
  await expect(page.getByText(CAPTION)).toHaveCount(0);
});

test("re-uploading the same photo dedups at the platform layer", async ({ page }) => {
  await page.goto(photosUrl);
  await expect(page.getByAltText("sunset.png").first()).toBeVisible({
    timeout: 60_000,
  });
  const countBefore = await page.getByAltText("sunset.png").count();

  await page.locator('input[type="file"]').first().setInputFiles(fixturePath);
  await expect(page.getByRole("status")).toContainText("is already in your photos");
  expect(await page.getByAltText("sunset.png").count()).toBe(countBefore);
});

test("uninstall: app data is gone, shared records survive in Drive", async ({ page }) => {
  // Stop, then uninstall through the UI (native confirm dialog).
  await page.goto(adminUrl());
  const card = photosCard(page);
  await card.getByRole("button", { name: "Stop" }).click();
  await expect(card.getByRole("button", { name: "Start" })).toBeVisible({
    timeout: 60_000,
  });

  page.on("dialog", (dialog) => void dialog.accept());
  await card.getByRole("button", { name: "Uninstall" }).click();
  await expect(card.getByRole("button", { name: "Install", exact: true })).toBeVisible({
    timeout: 60_000,
  });

  // The shared photo record survives the uninstall.
  await page.goto(driveUrl());
  await expect(page.getByRole("row").filter({ hasText: "sunset.png" }).first()).toBeVisible();
});

test("reinstall re-exposes the shared photos; captions are gone", async ({ page }) => {
  await page.goto(adminUrl());
  const card = photosCard(page);
  await card.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByRole("button", { name: "Approve & Install" }).click();
  await expect(card.getByText("Installed")).toBeVisible({ timeout: 60_000 });

  const { url } = await startAppDaemonViaAdmin(adminUrl(), "photos");
  photosUrl = url;

  await page.goto(photosUrl);
  // Shared data (the photo) is visible again through the fresh grant…
  await expect(page.getByAltText("sunset.png").first()).toBeVisible({
    timeout: 120_000,
  });
  // …but the caption lived in the app's own (dropped) table.
  const caption = await openPhotosViewerCaption(page);
  await expect(caption).toHaveValue("");
});

test("a corrupted HMAC secret turns into 401s and a visible error state", async ({ page }) => {
  // Corrupt the persisted secret, then restart photos so its per-process
  // credential cache re-reads the file.
  const credsPath = join(adminDataDir(), "app-creds", "photos.json");
  const creds = JSON.parse(await readFile(credsPath, "utf-8")) as {
    hmacSecret: string;
  };
  creds.hmacSecret = "corrupted-secret";
  await writeFile(credsPath, JSON.stringify(creds, null, 2));

  await stopAppDaemonViaAdmin(adminUrl(), "photos");
  const { url } = await startAppDaemonViaAdmin(adminUrl(), "photos");
  photosUrl = url;

  // The app's server-side proxy signs with the bad secret; the LDS refuses.
  await eventually(async () => {
    const res = await fetch(`${photosUrl}/api/local-data/data/records`);
    expect(res.status).toBe(401);
  });

  // And the UI surfaces it rather than rendering an empty-but-healthy grid.
  // Scope to the app's own error banner ("Data server GET … → 401"); under
  // `next dev` a bare /→ 401/ also matches the Next.js error overlay that the
  // data-server-client's throw produces, which is a dev-only artifact.
  await page.goto(photosUrl);
  await expect(page.getByText(/Data server GET .*→ 401/)).toBeVisible({ timeout: 60_000 });
});
