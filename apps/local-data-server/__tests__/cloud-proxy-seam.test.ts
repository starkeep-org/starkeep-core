/**
 * Integration coverage for the local-data-server `/cloud/data/*` proxy seam:
 * the wired chain drive-client → LDS `/cloud/data/*` proxy → cloud verifier,
 * exercised as one path with a *real* signature check.
 *
 * Why this earns its keep:
 *   The proxy once shipped `Authorization: Bearer <idToken>` instead of the
 *   signature the cloud verifier requires — fully breaking the Drive cloud
 *   view — and CI never caught it, because no test drove a real signature
 *   check *through the proxy*. The fake cloud verifies a registered device's
 *   Ed25519 signature exactly as the real cloud does, and these cases hit
 *   `/cloud/data/*` through the proxy.
 *
 * A key the cloud does not accept is characterized too: the machine neither
 * syncs nor proxies, and says why, rather than forwarding requests that can
 * only come back 401.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { deviceSigner } from "@starkeep/protocol-primitives";
import {
  startLocalDataServer,
  startFakeCloud,
  type LocalDataServer,
  type FakeCloud,
} from "@starkeep/testkit";
import { builtinAppCreds, createRecordWithBytes, type InstalledApp } from "./helpers.js";

const DRIVE = "starkeep-drive";

function serverConfig(cloudUrl: string) {
  return { apiGatewayUrl: cloudUrl, pullIntervalMs: 600_000, pushDebounceMs: 50 };
}

describe("LDS /cloud/data proxy with a real device signature check", () => {
  let cloud: FakeCloud;
  let server: LocalDataServer;
  let drive: InstalledApp;

  beforeAll(async () => {
    cloud = await startFakeCloud();
    // The cloud accepts only devices it has a record of, and verifies each
    // signature against the recorded key — the sync exchange *and* the proxy.
    cloud.devicePolicy.autoApprove = false;
    server = await startLocalDataServer({ config: serverConfig(cloud.url) });
    cloud.registerDevice(server.device!.deviceId, {
      publicKeySpki: server.device!.publicKeySpki,
      userId: "sub-1",
      kind: "desktop",
      label: null,
    });
    await fetch(`${server.url}/device/check`, { method: "POST" });
    drive = await builtinAppCreds(server, DRIVE);
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await cloud?.close();
  });

  it("ships a record up under a real signature, then reads the cloud view back through the proxy", async () => {
    // Push a record to the cloud. The exchange and file requests are verified
    // by the fake cloud, so this also proves the sync signer.
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

describe("a key the cloud records differently", () => {
  let cloud: FakeCloud;
  let server: LocalDataServer;
  let drive: InstalledApp;

  beforeAll(async () => {
    cloud = await startFakeCloud();
    cloud.devicePolicy.autoApprove = false;
    server = await startLocalDataServer({ config: serverConfig(cloud.url) });
    // The cloud's record names this device with some other key, so no
    // signature this machine makes verifies.
    cloud.registerDevice(server.device!.deviceId, {
      publicKeySpki: deviceSigner("other", new Uint8Array(randomBytes(32))).publicKeySpki,
      userId: "sub-1",
      kind: "desktop",
      label: null,
    });
    drive = await builtinAppCreds(server, DRIVE);
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await cloud?.close();
  });

  it("does not sync, and says the machine is not connected", async () => {
    const device = (await (await fetch(`${server.url}/device/check`, { method: "POST" })).json()) as {
      approval: { state: string };
    };
    expect(device.approval.state).toBe("pending");
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
