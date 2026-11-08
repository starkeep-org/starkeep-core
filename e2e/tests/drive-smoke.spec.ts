/**
 * Tier-2 Drive UI smoke (plan case 6): the records list and type sidebar
 * render real LDS data through Drive's server-side HMAC client, and the page
 * live-updates on an /events kick (the Drive page subscribes via the
 * same-origin /api/events SSE proxy and re-fetches on each kick).
 */

import http from "node:http";
import { expect, test } from "@playwright/test";
import { createRecordWithBytes, driveCreds, solidPng } from "@starkeep/e2e";

const ldsUrl = () => process.env.E2E_LDS_URL!;
const driveUrl = () => process.env.E2E_DRIVE_URL!;

test("records list and type sidebar render from the live data server", async ({ page }) => {
  const drive = await driveCreds(ldsUrl());
  await createRecordWithBytes(drive, {
    bytes: solidPng([0, 128, 255], 4),
    type: "image/png",
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

  // Type sidebar: an image/png chip with a count; clicking it filters the list.
  const chip = page.getByRole("button", { name: /^image\/png \(\d+\)$/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole("row").filter({ hasText: "drive-smoke.png" })).toBeVisible();
});

test("live-updates when a record is added underneath it via an /events kick", async ({ page }) => {
  const drive = await driveCreds(ldsUrl());

  // Open the page first, with no matching row present yet. The page mounts an
  // EventSource on /api/events; we must wait until that SSE stream is live
  // before writing, because the LDS kick is one-shot (never replayed) — a
  // record created before the subscriber is attached fires a kick into the
  // void and the page never re-fetches. The same-origin proxy only returns
  // response headers once its upstream LDS /events connection (and thus the
  // SSE subscriber) is in place, so the response is the readiness signal.
  const eventsConnected = page.waitForResponse(
    (r) => r.url().includes("/api/events") && r.status() === 200,
  );
  await page.goto(driveUrl());
  await expect(page.getByRole("heading", { name: "Starkeep Drive" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "live-update.png" })).toHaveCount(0);
  await eventsConnected;

  // Create a record now that the page is loaded and the SSE is live. The LDS write kicks /events;
  // the page's EventSource (proxied via /api/events) re-fetches and the new
  // row appears with no manual reload.
  await createRecordWithBytes(drive, {
    bytes: solidPng([255, 0, 0], 4),
    type: "image/png",
    contentType: "image/png",
    fileName: "live-update.png",
  });

  await expect(page.getByRole("row").filter({ hasText: "live-update.png" })).toBeVisible({
    timeout: 30_000,
  });
});

/**
 * Drive's server refuses a write from another site's page. Such a page can
 * send a blind `no-cors` POST to 127.0.0.1 with a loopback `Host`, so only
 * `Sec-Fetch-Site` tells the two apart. node:http sends the browser's headers
 * as given, which Playwright's request context does not.
 */
test("refuses a POST from another site, and still opens from another site's link", async () => {
  const drive = new URL(driveUrl());
  const send = (method: string, path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: drive.hostname, port: drive.port, method, path, headers },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(method === "POST" ? "{}" : undefined);
    });
  const restore = "/api/trash/no-such-record/restore";

  for (const site of ["cross-site", "same-site"]) {
    const refused = await send("POST", restore, {
      "Content-Type": "text/plain",
      "Sec-Fetch-Site": site,
      "Sec-Fetch-Mode": "no-cors",
    });
    expect(refused.status, site).toBe(403);
    expect(JSON.parse(refused.body)).toEqual({ error: "Drive refuses requests from other sites" });
  }
  // A form POST is a navigation, and it is refused too.
  expect(
    (await send("POST", restore, { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" }))
      .status,
  ).toBe(403);
  // admin-web's link to Drive is a same-site GET navigation, and it opens.
  expect(
    (await send("GET", "/", { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate" }))
      .status,
  ).toBe(200);
  // A caller that is no browser page sends no Sec-Fetch-Site and reaches the
  // route, which answers for the record it cannot find.
  expect((await send("POST", restore, { "Content-Type": "application/json" })).status).not.toBe(
    403,
  );
});
