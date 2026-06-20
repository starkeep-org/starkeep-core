/**
 * Regression: the local-data-server must pick up cloud config (Cognito pool
 * IDs) written to ~/.starkeep/config.json *after* it has booted — without a
 * restart.
 *
 * Why this is a real, non-obvious gap:
 *   The cloud-setup wizard writes the pool IDs to config.json through the admin
 *   web app's `/api/config` route. That write goes straight to the file; it does
 *   NOT go through this daemon and does NOT restart it. A long-lived LDS that
 *   snapshotted `cognitoConfig` once at boot (when the file had no pool IDs) used
 *   to keep reporting "No cloud config loaded" and 503 the sign-in handoff
 *   forever — the original bug. The auth handlers now reload config from disk per
 *   request; this test pins that behavior at the exact ordering the real flow
 *   has (daemon up first, config written by another writer second).
 *
 * Why this hermetic test still earns its keep alongside the e2e:
 *   `e2e-aws/journey.test.ts` now drives a real sign-in through `/auth/tokens`
 *   against AWS, so the handoff is no longer uncovered there. But the e2e boots
 *   the LDS with the Cognito pool IDs *already in config.json*, so it never
 *   exercises the specific failure ordering that shipped the original bug:
 *   daemon up first with no pool IDs, config written by another writer second,
 *   then auth. This test pins exactly that ordering, hermetically and without
 *   touching AWS.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";

let server: LocalDataServer;

beforeAll(async () => {
  // Boot with a config that has NO Cognito pool IDs — i.e. the daemon is already
  // running before cloud setup fills them in. `cognitoConfig` is null at boot.
  server = await startLocalDataServer({ config: {} });
}, 60_000);

afterAll(async () => {
  await server.stop();
});

async function authStatus(): Promise<{ configLoaded: boolean; authenticated: boolean }> {
  const res = await fetch(`${server.url}/auth/status`);
  expect(res.status).toBe(200);
  return (await res.json()) as { configLoaded: boolean; authenticated: boolean };
}

/** Simulate the admin web app's `/api/config` PATCH: a direct file write by
 *  another process, merged over the daemon's existing config, with no
 *  notification to this daemon. */
async function writePoolIdsToConfig(): Promise<void> {
  const configPath = join(server.starkeepDir, "config.json");
  const existing = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  await writeFile(
    configPath,
    JSON.stringify(
      {
        ...existing,
        userPoolId: "us-east-1_Testpool0",
        userPoolClientId: "0123456789abcdefghijklmnop",
        identityPoolId: "us-east-1:00000000-0000-0000-0000-000000000000",
      },
      null,
      2,
    ),
  );
}

describe("cloud config reload without restart (regression)", () => {
  it("reports no config and refuses the sign-in handoff before pool IDs are written", async () => {
    expect((await authStatus()).configLoaded).toBe(false);

    const res = await fetch(`${server.url}/auth/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "x", refreshToken: "y" }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/No cloud config loaded/);
  });

  it("picks up pool IDs written to config.json after boot — no restart", async () => {
    await writePoolIdsToConfig();

    // The daemon was never restarted, yet it now sees the config.
    expect((await authStatus()).configLoaded).toBe(true);
  });

  it("no longer short-circuits the sign-in handoff once config is on disk", async () => {
    // With config present, the handler clears the cognitoConfig guard and
    // reaches body validation. An empty body is rejected as 400 — NOT the stale
    // "No cloud config loaded" 503 — and crucially makes no network call to
    // Cognito, keeping this test hermetic.
    const tokens = await fetch(`${server.url}/auth/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(tokens.status).toBe(400);
    expect(((await tokens.json()) as { error: string }).error).toMatch(
      /idToken and refreshToken are required/,
    );

    // Same for /auth/login: past the config guard, into body validation.
    const login = await fetch(`${server.url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(login.status).toBe(400);
    expect(((await login.json()) as { error: string }).error).toMatch(
      /email and password are required/,
    );
  });
});
