/**
 * The `/cloud/data/*` proxy must present both halves of the cloud credential.
 *
 * The cloud data plane requires an end-user token alongside the app signature
 * on every `/apps/{appId}/*` call — the HMAC says which app is calling, the
 * token says a real person is behind it, and the cloud accepts neither in
 * place of the other (cloud-data-server/src/api-handler.ts → "Missing
 * X-Starkeep-User-Token"). The sync supervisor has always sent both
 * (sync-supervisor.ts → makeSignerFor). This proxy sent only the signature, so
 * every call came back 401 and Starkeep Drive showed a permanent "cloud view
 * unavailable — Missing X-Starkeep-User-Token" banner with every record marked
 * local-only, however completely it had synced.
 *
 * Both cases are pinned here: what the proxy forwards when a token is live,
 * and what it answers when there is none.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { startLocalDataServer, fakeIdToken, type LocalDataServer } from "@starkeep/testkit";
import { builtinAppCreds, type InstalledApp } from "./helpers.js";

/** Headers the fake cloud saw, per request path. */
const seen: Array<{ url: string; headers: Record<string, string> }> = [];

let cloud: Server;
let cloudUrl: string;

beforeAll(async () => {
  cloud = createServer((req, res) => {
    seen.push({
      url: req.url ?? "",
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
      ),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ records: [], types: [] }));
  });
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  cloudUrl = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => cloud.close(() => resolve()));
});

describe("with a live id token", () => {
  let server: LocalDataServer;
  let drive: InstalledApp;

  beforeAll(async () => {
    server = await startLocalDataServer({
      config: { apiGatewayUrl: cloudUrl },
      auth: { idToken: fakeIdToken() },
    });
    drive = await builtinAppCreds(server, "starkeep-drive");
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("forwards the end-user token alongside the app signature", async () => {
    seen.length = 0;
    const res = await drive.fetch("/cloud/data/records?limit=1000");
    expect(res.status).toBe(200);

    expect(seen).toHaveLength(1);
    const { url, headers } = seen[0]!;
    // Reaches the cloud under the app's own prefix, query string intact.
    expect(url).toBe("/apps/starkeep-drive/data/records?limit=1000");
    // The app half.
    expect(headers["x-starkeep-app-id"]).toBe("starkeep-drive");
    expect(headers["x-starkeep-app-sig"]).toBeTruthy();
    expect(headers["x-starkeep-app-ts"]).toBeTruthy();
    // The end-user half — the regression this test exists for. A present but
    // empty header is the same 401 from the cloud's point of view, so assert
    // on the value rather than on the key.
    expect(headers["x-starkeep-user-token"]).toBeTruthy();
    expect(headers["x-starkeep-user-token"]).toContain(".");
  });

  it("sends both halves on the types route too", async () => {
    seen.length = 0;
    const res = await drive.fetch("/cloud/data/types");
    expect(res.status).toBe(200);
    expect(seen[0]!.headers["x-starkeep-user-token"]).toBeTruthy();
    expect(seen[0]!.headers["x-starkeep-app-sig"]).toBeTruthy();
  });
});

describe("with no id token", () => {
  let server: LocalDataServer;
  let drive: InstalledApp;

  beforeAll(async () => {
    // Cloud configured, nobody signed in.
    server = await startLocalDataServer({ config: { apiGatewayUrl: cloudUrl } });
    drive = await builtinAppCreds(server, "starkeep-drive");
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("refuses locally instead of forwarding a request the cloud must reject", async () => {
    seen.length = 0;
    const res = await drive.fetch("/cloud/data/records");
    expect(res.status).toBe(503);
    // The caller renders this string. It has to name the actual condition —
    // the header name the cloud used to return is not something a person can
    // act on.
    expect(((await res.json()) as { error: string }).error).toMatch(/not signed in/i);
    expect(seen).toHaveLength(0);
  });
});
