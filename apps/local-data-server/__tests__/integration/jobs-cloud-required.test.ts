/**
 * Scheduled jobs and the credential vault are in the cloud only. The local
 * data server answers an app's job list, "run now" and every vault route with
 * 501 and `cloud-required`, so the app can say that they need a cloud.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listJobs, listSecrets, putSecret, runJobNow } from "@starkeep/app-client";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { installApp, testAppManifest, type InstalledApp } from "../helpers.js";

let server: LocalDataServer;
let app: InstalledApp;

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(server, testAppManifest());
}, 60_000);

afterAll(async () => {
  await server.stop();
});

describe("job and vault routes on the local surface", () => {
  it("answer 501 cloud-required to a signed call", async () => {
    for (const [method, path] of [
      ["GET", "/jobs"],
      ["POST", "/jobs/tick/run"],
      ["GET", "/vault"],
      ["PUT", "/vault/peloton"],
      ["GET", "/vault/peloton"],
      ["DELETE", "/vault/peloton"],
    ] as const) {
      const res = await app.fetch(path, { method });
      expect(res.status, `${method} ${path}`).toBe(501);
      expect(await res.json()).toMatchObject({ code: "cloud-required" });
    }
  });

  it("read as cloudRequired through the app-client helpers", async () => {
    const creds = {
      appId: app.appId,
      hmacSecret: app.hmacSecret,
      dataServerUrl: app.dataServerUrl,
    };
    expect(await listJobs(app.appId, { userToken: null, creds })).toEqual({
      cloudRequired: true,
      jobs: [],
    });
    expect(await runJobNow(app.appId, "tick", { userToken: null, creds })).toEqual({
      ok: false,
      cloudRequired: true,
    });
    expect(await listSecrets(app.appId, { userToken: null, creds })).toEqual({
      ok: false,
      cloudRequired: true,
    });
    expect(await putSecret(app.appId, "peloton", "x", { userToken: null, creds })).toEqual({
      ok: false,
      cloudRequired: true,
    });
  });

  it("still refuses an unsigned call", async () => {
    const res = await fetch(`${server.url}/jobs`);
    expect(res.status).toBe(401);
  });
});
