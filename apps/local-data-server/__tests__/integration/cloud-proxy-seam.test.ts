/**
 * Integration coverage for the local-data-server `/cloud/data/*` proxy seam:
 * the wired chain drive-client → LDS `/cloud/data/*` proxy → cloud verifier,
 * exercised as one path with a *real* credential check.
 *
 * Why this earns its keep:
 *   The proxy once shipped `Authorization: Bearer <idToken>` instead of the
 *   credential the cloud verifier requires — fully breaking the Drive cloud
 *   view — and CI never caught it, because no test drove a real check
 *   *through the proxy*. The fake cloud verifies the device token against its
 *   fake pool exactly as the real cloud's device-token branch does, and these
 *   cases hit `/cloud/data/*` through the proxy.
 *
 * A machine that is not signed in is characterized too: it neither syncs nor
 * proxies, and says why, rather than forwarding requests that can only come
 * back 401.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startLocalDataServer,
  startFakeCloud,
  type LocalDataServer,
  type FakeCloud,
} from "@starkeep/testkit";
import { builtinAppCreds, createRecordWithBytes, type InstalledApp } from "../helpers.js";

const DRIVE = "starkeep-drive";

function serverConfig(cloudUrl: string) {
  return { apiGatewayUrl: cloudUrl, pullIntervalMs: 600_000, pushDebounceMs: 50 };
}

describe("LDS /cloud/data proxy with a real device-token check", () => {
  let cloud: FakeCloud;
  let server: LocalDataServer;
  let drive: InstalledApp;

  beforeAll(async () => {
    cloud = await startFakeCloud();
    // The harness signs the machine in to the fake pool; the cloud then checks
    // the token on the sync exchange *and* the proxy.
    server = await startLocalDataServer({ config: serverConfig(cloud.url) });
    drive = await builtinAppCreds(server, DRIVE);
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await cloud?.close();
  });

  it("ships a record up under a real token, then reads the cloud view back through the proxy", async () => {
    // Push a record to the cloud. The exchange and file requests are checked
    // by the fake cloud, so this also proves the sync credential.
    await createRecordWithBytes(drive, { bytes: "proxy-bytes", fileName: "proxy-1.jpg" });
    const now = await drive.fetch("/sync/now", { method: "POST" });
    expect(now.status).toBe(200);

    // No swallowed auth error on the exchange path.
    const status = await drive.fetch("/sync/status");
    const { perApp } = (await status.json()) as {
      perApp: Array<{ appId: string; lastError: string | null }>;
    };
    expect(perApp.find((e) => e.appId === DRIVE)?.lastError).toBeNull();

    // The Drive cloud view, fetched *through the LDS proxy* (drive → LDS →
    // cloud), succeeds and reflects what was pushed.
    const res = await drive.fetch("/cloud/data/types");
    expect(res.status).toBe(200);
    const { types, total } = (await res.json()) as {
      types: Array<{ record_type: string; count: number }>;
      total: number;
    };
    expect(total).toBeGreaterThanOrEqual(1);
    expect(types.map((t) => t.record_type)).toContain("image/jpeg");
  });

  it("reads records through the proxy under the same check", async () => {
    const res = await drive.fetch(
      `/cloud/data/records?where=${encodeURIComponent(JSON.stringify({ type: "image/jpeg" }))}`,
    );
    expect(res.status).toBe(200);
    const { records } = (await res.json()) as { records: Array<{ type?: string }> };
    expect(records.length).toBeGreaterThanOrEqual(1);
  });
});

describe("a machine that is not signed in", () => {
  let cloud: FakeCloud;
  let server: LocalDataServer;
  let drive: InstalledApp;

  beforeAll(async () => {
    cloud = await startFakeCloud();
    server = await startLocalDataServer({ config: serverConfig(cloud.url), signIn: false });
    drive = await builtinAppCreds(server, DRIVE);
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await cloud?.close();
  });

  it("does not sync", async () => {
    const status = (await (await drive.fetch("/sync/status")).json()) as { enabled: boolean };
    expect(status.enabled).toBe(false);
  });

  it("refuses the cloud view locally rather than forwarding a request the cloud must reject", async () => {
    const before = cloud.exchangeLog.length;
    const res = await drive.fetch("/cloud/data/types");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/not signed in to the cloud/);
    expect(cloud.exchangeLog.length).toBe(before);
  });
});
