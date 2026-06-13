/**
 * Tier-2 Drive UI smoke (plan case 6): the records list and type sidebar
 * render real LDS data through Drive's server-side HMAC client.
 *
 * Note: the plan also lists "live-updates on /events kick" — the Drive page
 * does not subscribe to /events today (it fetches once on mount), so there is
 * no behavior to pin. Open product finding, reported alongside this suite.
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
