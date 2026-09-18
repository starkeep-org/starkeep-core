/**
 * Tier-2: the three ways an app can leave a node, driven from the dashboard.
 *
 * `probe-platform.spec.ts` covers the operator journey through an uninstall
 * that takes the data with it. This file covers the choice that journey now
 * makes: an uninstall keeps the app's data unless the operator ticks the box,
 * and a node-local removal is a third thing that is neither.
 *
 * These are verification steps 1 and 3 of
 * `implementation-status-rendition-ownership-phase-1-2026-09-17.md` §5, at the
 * layer this tier owns — the dialog, the routes behind it, and what survives on
 * disk. What a node-local removal does *not* do, and what a reinstalled node
 * pulls back from the cloud, need a second party and are asserted in
 * `apps/local-data-server/__tests__/app-removal-over-wire.test.ts`.
 *
 * Probe rather than a real application, for the reason the Tier-2 suite gives
 * everywhere else: none of these claims is about any particular app, and core
 * must not assume one exists.
 *
 * Serial, and self-contained at the front: it reinstalls Probe from scratch in
 * `beforeAll` rather than inheriting whatever the previous file left, because
 * the last thing `probe-platform.spec.ts` does is corrupt Probe's signing
 * secret.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  eventually,
  installAppViaAdmin,
  solidPng,
  startAppDaemonViaAdmin,
  stopAppDaemonViaAdmin,
  uninstallAppViaAdmin,
} from "@starkeep/e2e";

test.describe.configure({ mode: "serial" });

const adminUrl = () => process.env.E2E_ADMIN_URL!;
const driveUrl = () => process.env.E2E_DRIVE_URL!;

const FIXTURE_NAME = "probe-removal.png";
const NOTE = "an app-private note that should outlive an uninstall";

let fixturePath: string;
let probeUrl: string;

function probeCard(page: Page): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("Probe", { exact: true }) })
    .first();
}

/** Run one of a card's secondary actions; the menu renders in a portal. */
async function cardMenuAction(page: Page, card: Locator, label: string): Promise<void> {
  await card.getByRole("button", { name: /^More actions for / }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

/** Stop Probe from the dashboard, which both removals require first. */
async function stopFromDashboard(page: Page, card: Locator): Promise<void> {
  const startButton = card.getByRole("button", { name: /^Start / });
  if (await startButton.isVisible().catch(() => false)) return;
  await cardMenuAction(page, card, "Stop");
  await expect(startButton).toBeVisible({ timeout: 60_000 });
}

/** Install Probe through the consent dialog and start it; returns its URL. */
async function installAndStart(page: Page): Promise<string> {
  const card = probeCard(page);
  await card.getByRole("button", { name: /^Install / }).click();
  await page.getByRole("button", { name: "Approve & Install" }).click();
  await expect(card.getByText("Installed", { exact: true })).toBeVisible({ timeout: 60_000 });
  const { url } = await startAppDaemonViaAdmin(adminUrl(), "probe");
  return url;
}

/** Probe's app-private rows, read through Probe's own signing proxy. */
async function probeNotes(page: Page): Promise<string> {
  await page.goto(probeUrl);
  await expect(page.getByLabel("Upload")).toBeVisible({ timeout: 60_000 });
  return page.evaluate(async () => {
    const res = await fetch("/api/local-data/app-data/db/probe_notes");
    return res.ok ? await res.text() : `status ${res.status}`;
  });
}

test.beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "starkeep-probe-removal-"));
  fixturePath = join(dir, FIXTURE_NAME);
  await writeFile(fixturePath, solidPng([10, 160, 90], 8));

  // A known-clean start: the app gone along with its data, then installed
  // fresh. Both halves matter — `probe-platform.spec.ts` ends with Probe
  // installed under a deliberately corrupted signing secret, and an uninstall
  // now keeps the tables, so only `deleteData` gets back to nothing.
  await stopAppDaemonViaAdmin(adminUrl(), "probe").catch(() => {
    /* not running */
  });
  await uninstallAppViaAdmin(adminUrl(), "probe", { deleteData: true }).catch(() => {
    /* not installed */
  });
  await installAppViaAdmin(adminUrl(), "probe");
  const { url } = await startAppDaemonViaAdmin(adminUrl(), "probe");
  probeUrl = url;
});

test("seed: a shared record and an app-private row", async ({ page }) => {
  await page.goto(probeUrl);
  await page.locator('input[type="file"]').first().setInputFiles(fixturePath);
  await expect(page.getByAltText(FIXTURE_NAME).first()).toBeVisible({ timeout: 60_000 });

  const written = await page.evaluate(async (note) => {
    const res = await fetch("/api/local-data/app-data/db/probe_notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { record_id: "probe-removal", note } }),
    });
    return res.status;
  }, NOTE);
  expect(written).toBe(200);
  expect(await probeNotes(page)).toContain(NOTE);
});

test("the uninstall dialog offers to delete the data, and does not do it unasked", async ({
  page,
}) => {
  await page.goto(adminUrl());
  const card = probeCard(page);
  await stopFromDashboard(page, card);

  await cardMenuAction(page, card, "Uninstall");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Uninstall Probe?")).toBeVisible();

  // Unticked on open, and the confirming button says what that means. Both
  // are the contract: an operator who reads nothing and clicks the obvious
  // button keeps their data.
  const deleteBox = dialog.getByRole("checkbox");
  await expect(deleteBox).not.toBeChecked();
  await expect(dialog.getByRole("button", { name: "Uninstall, keep data" })).toBeVisible();
  // The destructive warning belongs to the ticked state, not the open one.
  await expect(dialog.getByText("This deletes Probe’s own data")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Uninstall, keep data" }).click();
  await expect(card.getByRole("button", { name: /^Install / })).toBeVisible({
    timeout: 60_000,
  });

  // Shared records are the user's and survive every removal.
  await page.goto(driveUrl());
  await expect(page.getByRole("row").filter({ hasText: FIXTURE_NAME }).first()).toBeVisible();
});

test("reinstalling reads back the app-private row the uninstall left behind", async ({
  page,
}) => {
  await page.goto(adminUrl());
  probeUrl = await installAndStart(page);

  // The claim the whole default exists for: the app's own table came back with
  // its rows, so replacing an app with a new version is an upgrade.
  expect(await probeNotes(page)).toContain(NOTE);

  // And the shared record is visible again through the fresh grant.
  await page.goto(probeUrl);
  await expect(page.getByAltText(FIXTURE_NAME).first()).toBeVisible({ timeout: 120_000 });
});

test("ticking the box is what deletes the app's data", async ({ page }) => {
  await page.goto(adminUrl());
  const card = probeCard(page);
  await stopFromDashboard(page, card);

  await cardMenuAction(page, card, "Uninstall");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  // Now the warning, and now a button that names the destruction.
  await expect(dialog.getByText("This deletes Probe’s own data")).toBeVisible();
  await dialog.getByRole("button", { name: "Uninstall and delete data" }).click();
  await expect(card.getByRole("button", { name: /^Install / })).toBeVisible({
    timeout: 60_000,
  });

  probeUrl = await installAndStart(page);
  expect(await probeNotes(page)).not.toContain(NOTE);

  // Shared records still survive — that is not what the box governs.
  await page.goto(driveUrl());
  await expect(page.getByRole("row").filter({ hasText: FIXTURE_NAME }).first()).toBeVisible();
});

test("remove from this node drops this machine's copy, with no choice to offer", async ({
  page,
}) => {
  // Re-seed the row the previous test deleted, so the removal has something of
  // the app's own to take.
  await page.goto(probeUrl);
  await expect(page.getByLabel("Upload")).toBeVisible({ timeout: 60_000 });
  await page.evaluate(async (note) => {
    await fetch("/api/local-data/app-data/db/probe_notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { record_id: "probe-removal", note } }),
    });
  }, NOTE);

  await page.goto(adminUrl());
  const card = probeCard(page);
  await stopFromDashboard(page, card);

  await cardMenuAction(page, card, "Remove from this node…");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Remove Probe from this node?")).toBeVisible();
  // No checkbox: a node-local removal deletes this node's copy by definition,
  // so a "keep it" option would be an option to do nothing.
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Remove from this node" }).click();
  await expect(card.getByRole("button", { name: /^Install / })).toBeVisible({
    timeout: 60_000,
  });

  probeUrl = await installAndStart(page);
  expect(await probeNotes(page)).not.toContain(NOTE);

  // The user's records are untouched: this removal is about the app's copy of
  // its own state, not about the data the app wrote into shared storage.
  await page.goto(driveUrl());
  await expect(page.getByRole("row").filter({ hasText: FIXTURE_NAME }).first()).toBeVisible();
});

test.afterAll(async () => {
  // Leave the stack as this file found it, data included.
  await stopAppDaemonViaAdmin(adminUrl(), "probe").catch(() => {
    /* already stopped */
  });
  await uninstallAppViaAdmin(adminUrl(), "probe", { deleteData: true }).catch(() => {
    /* already gone */
  });
  await eventually(async () => {
    const res = await fetch(`${adminUrl()}/api/apps/list`);
    expect(res.ok).toBe(true);
  });
});
