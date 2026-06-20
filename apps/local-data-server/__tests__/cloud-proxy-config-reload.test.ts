/**
 * Characterization (todo 38, gap 2): the local-data-server boot-captures
 * `CLOUD_URL` (server.ts: `const CLOUD_URL = starkeepConfig.apiGatewayUrl`),
 * so the `/cloud/data/*` proxy does NOT pick up `apiGatewayUrl` written to
 * config.json *after* boot — unlike the auth handlers, which reload config per
 * request (see auth-config-reload.test.ts).
 *
 * Real-world ordering this reproduces: the cloud-setup wizard writes
 * `apiGatewayUrl` to config.json through admin-web's `/api/config` route while
 * the LDS is already running. That write does not restart the daemon. A
 * long-lived LDS that snapshotted `CLOUD_URL` at boot (when it was absent)
 * keeps reporting "Cloud is not configured" from the proxy forever.
 *
 * This pins the *current, wrong* behavior on purpose. The install route now
 * restarts the LDS on success as a stopgap (added 2026-06-18), and the durable
 * fix — making `CLOUD_URL` a per-request read like the auth handlers — is
 * deferred. When that fix lands, flip the second assertion to expect the proxy
 * to see the post-boot apiGatewayUrl (i.e. NOT 503) and drop this note.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startLocalDataServer, fakeIdToken, type LocalDataServer } from "@starkeep/testkit";
import { builtinAppCreds, type InstalledApp } from "./helpers.js";

let server: LocalDataServer;
let drive: InstalledApp;

beforeAll(async () => {
  // Boot WITHOUT apiGatewayUrl — i.e. the daemon is running before cloud setup
  // fills it in. CLOUD_URL is undefined at boot.
  server = await startLocalDataServer({ config: {}, auth: { idToken: fakeIdToken() } });
  drive = await builtinAppCreds(server, "starkeep-drive");
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

/** Simulate admin-web's `/api/config` PATCH: a direct file write by another
 *  process, merged over the daemon's config, with no notification/restart. */
async function writeApiGatewayUrlToConfig(): Promise<void> {
  const configPath = join(server.starkeepDir, "config.json");
  const existing = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  await writeFile(
    configPath,
    JSON.stringify({ ...existing, apiGatewayUrl: "https://cloud.example.test" }, null, 2),
  );
}

describe("cloud proxy CLOUD_URL boot-capture (characterization)", () => {
  it("503s the proxy before any apiGatewayUrl is configured", async () => {
    const res = await drive.fetch("/cloud/data/types");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/Cloud is not configured/);
  });

  it("still 503s the proxy after apiGatewayUrl is written post-boot — no restart (the bug)", async () => {
    await writeApiGatewayUrlToConfig();

    // The auth handlers would now see the new config (per-request reload), but
    // the proxy reads the boot-captured CLOUD_URL const, so it stays blind.
    const res = await drive.fetch("/cloud/data/types");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/Cloud is not configured/);
  });
});
