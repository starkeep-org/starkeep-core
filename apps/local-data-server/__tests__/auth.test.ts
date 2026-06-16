/**
 * Request-auth contract: HMAC on the data plane, loopback on the admin plane,
 * signed tokens in file URLs. (Plan §3 "Request auth".)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { signRequest } from "@starkeep/app-client";
import { installApp, testAppManifest, createRecordWithBytes, type InstalledApp } from "./helpers.js";

let server: LocalDataServer;
let app: InstalledApp;

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(server, testAppManifest());
}, 60_000);

afterAll(async () => {
  await server.stop();
});

describe("HMAC on the data plane", () => {
  it("accepts a correctly signed request", async () => {
    const res = await app.fetch("/data/types");
    expect(res.status).toBe(200);
  });

  it("rejects requests with no app headers", async () => {
    const res = await fetch(`${server.url}/data/types`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("X-Starkeep-App-Id");
  });

  it("rejects a signature minted with the wrong secret", async () => {
    const headers = signRequest({
      appId: app.appId,
      hmacSecret: "wrong-secret",
      method: "GET",
      path: "/data/types",
    });
    const res = await fetch(`${server.url}/data/types`, { headers });
    expect(res.status).toBe(401);
  });

  it("rejects a sig from one app id presented under another (id binding)", async () => {
    const sig = signRequest({
      appId: app.appId,
      hmacSecret: app.hmacSecret,
      method: "GET",
      path: "/data/types",
    });
    const res = await fetch(`${server.url}/data/types`, {
      headers: {
        "X-Starkeep-App-Id": "starkeep-drive",
        "X-Starkeep-App-Sig": sig["X-Starkeep-App-Sig"],
        "X-Starkeep-App-Ts": sig["X-Starkeep-App-Ts"],
      },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a signature replayed against a different path (path binding)", async () => {
    // Sign for /data/types, present at /data/records — must be rejected.
    const headers = signRequest({
      appId: app.appId,
      hmacSecret: app.hmacSecret,
      method: "GET",
      path: "/data/types",
    });
    const res = await fetch(`${server.url}/data/records`, { headers });
    expect(res.status).toBe(401);
  });

  it("rejects a stale signature outside the freshness window", async () => {
    const headers = signRequest({
      appId: app.appId,
      hmacSecret: app.hmacSecret,
      method: "GET",
      path: "/data/types",
      timestamp: Date.now() - 10 * 60_000,
    });
    const res = await fetch(`${server.url}/data/types`, { headers });
    expect(res.status).toBe(401);
  });

  it("rejects when the body is tampered after signing", async () => {
    const body = JSON.stringify({ type: "image/jpeg", contentType: "image/jpeg", contentHash: "0".repeat(64), sizeBytes: 1 });
    const headers = signRequest({
      appId: app.appId,
      hmacSecret: app.hmacSecret,
      method: "POST",
      path: "/data/records",
      body,
    });
    const tampered = body.replace("image/jpeg", "image/png");
    const res = await fetch(`${server.url}/data/records`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: tampered,
    });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown app id outright", async () => {
    const headers = signRequest({
      appId: "never-installed",
      hmacSecret: "whatever",
      method: "GET",
      path: "/data/types",
    });
    const res = await fetch(`${server.url}/data/types`, { headers });
    expect(res.status).toBe(401);
  });
});

describe("loopback-authorized routes", () => {
  it("admin and health routes work without any HMAC", async () => {
    for (const path of ["/health", "/config", "/admin/apps", "/watches", "/auth/status"]) {
      const res = await fetch(`${server.url}${path}`);
      expect(res.status, path).toBe(200);
    }
  });

  it("sync routes are data-plane: HMAC required", async () => {
    expect((await fetch(`${server.url}/sync/status`)).status).toBe(401);
    expect((await app.fetch("/sync/status")).status).toBe(200);
  });
});

describe("token-in-URL exemptions", () => {
  it("serves file bytes to an unauthenticated GET with a valid token", async () => {
    const bytes = Buffer.from("token-served-bytes");
    const { record } = await createRecordWithBytes(app, { bytes, fileName: "t.jpg" });
    const urlRes = await app.fetch(`/data/records/${record.id}/file-url`);
    expect(urlRes.status).toBe(200);
    const { url } = (await urlRes.json()) as { url: string };
    // Plain fetch — no HMAC headers.
    const fileRes = await fetch(url);
    expect(fileRes.status).toBe(200);
    expect(Buffer.from(await fileRes.arrayBuffer())).toEqual(bytes);
  });

  it("rejects garbage and forged tokens", async () => {
    const garbage = await fetch(`${server.url}/data/files/not-a-token`);
    expect(garbage.status).toBe(403);
    // Token signed with a key we invented (not the server's per-boot secret).
    const payload = Buffer.from("r|shared/image/aa/bb|image/jpeg|9999999999").toString("base64url");
    const sig = createHmac("sha256", "attacker-key").update("anything").digest("base64url");
    const forged = await fetch(`${server.url}/data/files/${payload}.${sig}`);
    expect(forged.status).toBe(403);
  });

  it("accepts presigned uploads without HMAC and verifies content hash", async () => {
    const bytes = Buffer.from("presigned-upload-bytes");
    const hash = createHmac("sha256", "").update("x").digest("hex"); // wrong hash on purpose below
    const presign = await app.fetch("/files/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: `shared/image/aa/${"a".repeat(64)}`,
        contentType: "image/jpeg",
      }),
    });
    expect(presign.status).toBe(200);
    const { url } = (await presign.json()) as { url: string };
    // Bytes that do not hash to the key are refused.
    const bad = await fetch(url, { method: "PUT", body: bytes });
    expect(bad.status).toBe(400);
    expect(hash).toBeDefined();
  });

  it("invalidates outstanding file tokens on server restart (per-boot secret)", async () => {
    const { record } = await createRecordWithBytes(app, { fileName: "restart.jpg" });
    const urlRes = await app.fetch(`/data/records/${record.id}/file-url`);
    const { url } = (await urlRes.json()) as { url: string };
    expect((await fetch(url)).status).toBe(200);

    await server.stopKeepData();
    server = await startLocalDataServer({ starkeepDir: server.starkeepDir, port: server.port });
    // App identity survives the restart (registry is durable)…
    app = { ...app, dataServerUrl: server.url };

    // …but the old token does not.
    const stale = await fetch(url);
    expect(stale.status).toBe(403);
  }, 60_000);
});
