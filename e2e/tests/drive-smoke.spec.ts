/**
 * Tier-2 Drive UI smoke (plan case 6): the records list and type sidebar
 * render real LDS data through Drive's server-side HMAC client, and the page
 * live-updates on an /events kick (the Drive page subscribes via the
 * same-origin /api/events SSE proxy and re-fetches on each kick).
 */

import { expect, test } from "@playwright/test";
import { createRecordWithBytes, driveCreds, solidPng } from "@starkeep/e2e";

const ldsUrl = () => process.env.E2E_LDS_URL!;
const driveUrl = () => process.env.E2E_DRIVE_URL!;

test("records list and type sidebar render from the live data server", async ({ page }) => {
  const drive = await driveCreds(ldsUrl());
  await createRecordWithBytes(drive, {
    bytes: solidPng([0, 128, 255], 4),
    type: "png",
    contentType: "image/png",
    fileName: "drive-smoke.png",
  });

  await page.goto(driveUrl());
  await expect(page.getByRole("heading", { name: "Starkeep Drive" })).toBeVisible();

  // The record row, attributed to its origin app, marked local-only (no
  // cloud is configured in this stack).
  const row = page.getByRole("row").filter({ hasText: "drive-smoke.png" });
  await expect(row).toContainText("starkeep-drive");
  await expect(row.getByText("Local only")).toBeVisible();

  // Cloud view degrades softly rather than failing the page.
  await expect(page.getByText(/Showing local data only/)).toBeVisible();

  // Type sidebar: a png chip with a count; clicking it filters the list.
  const chip = page.getByRole("button", { name: /^png \(\d+\)$/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole("row").filter({ hasText: "drive-smoke.png" })).toBeVisible();
});

test("live-updates when a record is added underneath it via an /events kick", async ({ page }) => {
  const drive = await driveCreds(ldsUrl());

  // Open the page first, with no matching row present yet.
  await page.goto(driveUrl());
  await expect(page.getByRole("heading", { name: "Starkeep Drive" })).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "live-update.png" }),
  ).toHaveCount(0);

  // Create a record after the page has loaded. The LDS write kicks /events;
  // the page's EventSource (proxied via /api/events) re-fetches and the new
  // row appears with no manual reload.
  await createRecordWithBytes(drive, {
    bytes: solidPng([255, 0, 0], 4),
    type: "png",
    contentType: "image/png",
    fileName: "live-update.png",
  });

  await expect(
    page.getByRole("row").filter({ hasText: "live-update.png" }),
  ).toBeVisible({ timeout: 30_000 });
});
