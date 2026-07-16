/**
 * A daemon that fails to start must say so in the admin UI — the operator sees
 * the reason, not a spinner that runs out. Complements the Tier-1 route tests
 * (apps/admin-web/__tests__/daemon.test.ts), which assert the 500 + diagnosis;
 * here the whole path runs for real: browser → daemon route → detached spawn →
 * dead child → error rendered on the Dashboard.
 *
 * Fixtures are throwaway apps in a temp parent dir, registered through the real
 * config API (what the App discovery card writes). Photos is deliberately not
 * the fixture: these flows need an app that *fails*, and photos-platform.spec
 * owns photos' state for the run.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "@starkeep/testkit";
import { eventually, installAppViaAdmin } from "@starkeep/e2e";

test.describe.configure({ mode: "serial" });

const adminUrl = () => process.env.E2E_ADMIN_URL!;
const adminDataDir = () => process.env.E2E_ADMIN_DATA_DIR!;

/** Parent dir holding this spec's fixture apps; added to appParentDirs in beforeAll. */
let fixturesDir: string;
/** appParentDirs as found, restored in afterAll so later specs scan what they expect. */
let originalParentDirs: string[];
/** Processes we deliberately orphaned (pid records removed), killed in afterAll. */
const strays: number[] = [];

function manifest(over: Record<string, unknown>): Record<string, unknown> {
  return {
    version: "1.0.0",
    tier: "community",
    infraRequirements: {
      fileAccess: [
        {
          types: ["image/png"],
          access: "readwrite",
          metadataWrite: true,
          rationale: "e2e fixture",
        },
      ],
    },
    ...over,
  };
}

async function writeFixtureApp(
  dirName: string,
  appManifest: Record<string, unknown>,
  files: Record<string, string> = {},
): Promise<string> {
  const appDir = join(fixturesDir, dirName);
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "starkeep.manifest.json"), JSON.stringify(appManifest, null, 2));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(appDir, name), content);
  }
  return appDir;
}

/** An app's card on the Dashboard, found by its display name. */
function appCard(page: Page, name: string): Locator {
  return page
    .locator("div.rounded-md.border")
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
}

/**
 * The section's error banner. Scoped to the shadcn Alert — a bare role=alert
 * also matches Next's route announcer, which is always in the dev DOM.
 */
function errorAlert(page: Page): Locator {
  return page.locator('[data-slot="alert"]');
}

/** Click Start and wait for the attempt to settle (the button stops saying "Starting…"). */
async function clickStart(page: Page, card: Locator): Promise<void> {
  await card.getByRole("button", { name: "Start" }).click();
  await expect(card.getByRole("button", { name: "Starting…" })).toHaveCount(0, { timeout: 60_000 });
}

async function patchParentDirs(dirs: string[]): Promise<void> {
  const res = await fetch(`${adminUrl()}/api/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appParentDirs: dirs }),
  });
  expect(res.ok).toBe(true);
}

test.beforeAll(async () => {
  fixturesDir = await mkdtemp(join(tmpdir(), "starkeep-e2e-daemon-fixtures-"));

  // A dev server with a broken build: prints its error and dies at once.
  await writeFixtureApp(
    "crash-app",
    manifest({
      id: "crash-app",
      name: "Crash App",
      localRun: { command: process.execPath, args: ["crash.mjs"] },
    }),
    { "crash.mjs": 'console.error("boom: fixture build failed");\nprocess.exit(1);\n' },
  );

  // A checkout that was never `pnpm install`ed: package.json, no node_modules.
  // The likeliest real failure — it's what the repo READMEs now warn about.
  await writeFixtureApp(
    "nodeps-app",
    manifest({
      id: "nodeps-app",
      name: "Nodeps App",
      localRun: { command: process.execPath, args: ["server.mjs"] },
    }),
    { "package.json": JSON.stringify({ name: "nodeps-app" }), "server.mjs": "" },
  );

  // Binds a hardcoded port (no portFlag, so admin allocates nothing) — starting
  // a second instance collides, the way a stale dev server collides with the
  // one the daemon route spawns.
  const hogPort = await getFreePort();
  await writeFixtureApp(
    "porthog-app",
    manifest({
      id: "porthog-app",
      name: "Porthog App",
      localRun: { command: process.execPath, args: ["server.mjs"] },
    }),
    {
      "server.mjs":
        'import { createServer } from "node:http";\n' +
        `createServer((_q, s) => s.end("ok")).listen(${hogPort}, "127.0.0.1");\n`,
    },
  );

  const res = await fetch(`${adminUrl()}/api/config`);
  const { config } = (await res.json()) as { config: { appParentDirs?: string[] } };
  originalParentDirs = config.appParentDirs ?? [];
  await patchParentDirs([...originalParentDirs, fixturesDir]);

  for (const id of ["crash-app", "nodeps-app", "porthog-app"]) {
    await installAppViaAdmin(adminUrl(), id);
  }
});

test.afterAll(async () => {
  for (const pid of strays) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  if (originalParentDirs) await patchParentDirs(originalParentDirs);
  await rm(fixturesDir, { recursive: true, force: true });
});

test("a daemon that dies at startup surfaces its log tail on the Dashboard", async ({ page }) => {
  await page.goto(adminUrl());
  const card = appCard(page, "Crash App");
  await expect(card.getByText("Installed")).toBeVisible();

  await clickStart(page, card);

  // The operator gets the daemon's own output, not just "it failed".
  const alert = errorAlert(page);
  await expect(alert).toContainText("exited during startup");
  await expect(alert).toContainText("boom: fixture build failed");

  // And the card settles back to an actionable Start rather than a stuck spinner.
  await expect(card.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(card.getByText(/Running :\d+/)).toHaveCount(0);
});

test("an app with no node_modules is refused with a pnpm install hint", async ({ page }) => {
  await page.goto(adminUrl());
  const card = appCard(page, "Nodeps App");

  await clickStart(page, card);

  const alert = errorAlert(page);
  await expect(alert).toContainText("pnpm install");
  await expect(alert).toContainText("nodeps-app");
  await expect(card.getByRole("button", { name: "Start" })).toBeVisible();
});

test("starting an app whose instance is already running fails with the collision, not silently", async ({
  page,
}) => {
  await page.goto(adminUrl());
  const card = appCard(page, "Porthog App");

  // First start comes up and holds the port.
  await clickStart(page, card);
  await expect(card.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 60_000 });

  // Orphan it: drop admin's pid records the way a crash or a bad stop would,
  // leaving the process alive and still holding its port. An installed app has
  // no fixed port to probe, so admin now believes it isn't running.
  const pidPath = join(adminDataDir(), "pids", "porthog-app.pid");
  const strayPid = parseInt(await readFile(pidPath, "utf-8"), 10);
  expect(Number.isNaN(strayPid)).toBe(false);
  strays.push(strayPid);
  await rm(pidPath, { force: true });
  await rm(join(adminDataDir(), "pids", "porthog-app.meta.json"), { force: true });

  await page.reload();
  const orphanedCard = appCard(page, "Porthog App");
  await expect(orphanedCard.getByRole("button", { name: "Start" })).toBeVisible();

  // Starting again spawns a duplicate that can't bind — the failure must reach
  // the operator with the reason attached.
  await clickStart(page, orphanedCard);
  const alert = errorAlert(page);
  await expect(alert).toContainText("exited during startup");
  await expect(alert).toContainText("EADDRINUSE");

  // The original instance is untouched — a failed start must not take down the
  // process that was already serving.
  await eventually(async () => {
    expect(() => process.kill(strayPid, 0)).not.toThrow();
  });
});
