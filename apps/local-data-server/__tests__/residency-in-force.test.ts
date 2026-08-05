/**
 * The two pieces of residency wiring that are decided at boot, and what makes
 * each of them observable.
 *
 *   - **The saved policy is the policy in force.** `PUT /residency/policy`
 *     validates, writes config, and restarts, because the residency manager is
 *     built at boot from that config. `residency-policy-routes.test.ts` covers
 *     the validation and that the policy is *reported* as configured
 *     afterwards; nothing checked that the rebuilt manager actually decides by
 *     the new table. A save that persisted and did not take effect would pass
 *     every existing assertion.
 *
 *   - **`refreshSizeClassKeys` after an install.** `sizeClassKeys` is mutated in
 *     place specifically so the manager — which closed over it at construction
 *     — sees an app installed later. An install that did not refresh it leaves
 *     that app's derivatives classified `<app>:unclassified` for as long as it
 *     is until an unrelated restart, and nothing reclassifies a resident-set
 *     row afterwards.
 *
 * The decision itself is observed where it has a visible consequence: whether
 * a synced record's bytes are here. That is what residency *is* on this node,
 * and it is the assertion a route echoing back the saved policy cannot make.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startLocalDataServer,
  startFakeCloud,
  fakeIdToken,
  type LocalDataServer,
  type FakeCloud,
} from "@starkeep/testkit";
import {
  builtinAppCreds,
  installApp,
  testAppManifest,
  createRecordWithBytes,
  eventually,
  type InstalledApp,
} from "./helpers.js";

const GB = 1024 ** 3;

let cloud: FakeCloud;
let serverA: LocalDataServer;
let serverB: LocalDataServer;
let driveA: InstalledApp;
let driveB: InstalledApp;

/** Keep everything: the baseline the tightened policy is measured against. */
const keepEverything = {
  platform: {
    rows: { "original:image": { keep: "all", budgetBytes: 10 * GB } },
    fallback: { keep: "all", budgetBytes: 10 * GB },
  },
  apps: {},
  appFallback: {
    rows: {},
    fallback: { keep: "all", budgetBytes: GB },
    totalBudgetBytes: GB,
  },
};

/** The same policy with one row changed — the change under test. */
const refuseImages = {
  ...keepEverything,
  platform: {
    rows: { "original:image": { keep: "never", budgetBytes: 0 } },
    fallback: { keep: "all", budgetBytes: 10 * GB },
  },
};

function serverConfig(cloudUrl: string, extra: Record<string, unknown> = {}) {
  return {
    apiGatewayUrl: cloudUrl,
    pullIntervalMs: 600_000,
    pushDebounceMs: 50,
    syncMaxItems: 5,
    ...extra,
  };
}

async function syncNow(app: InstalledApp): Promise<void> {
  const res = await app.fetch("/sync/now", { method: "POST" });
  expect(res.status).toBe(200);
}

/** Push A's writes to the cloud and pull them down onto B. */
async function converge(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await syncNow(driveA);
    await syncNow(driveB);
  }
}

/** Whether B holds the bytes, as opposed to merely the record. */
async function hasBytes(app: InstalledApp, recordId: string): Promise<boolean> {
  const res = await app.fetch(`/data/records/${recordId}/file-url`);
  if (!res.ok) return false;
  const { url } = (await res.json()) as { url: string };
  return (await fetch(url)).status === 200;
}

async function hasRecord(app: InstalledApp, recordId: string): Promise<boolean> {
  const res = await app.fetch(`/data/records/${recordId}`);
  return res.status === 200;
}

/** Wait for a self-restarting daemon to come back on the same port. */
async function waitForRestart(server: LocalDataServer): Promise<void> {
  await server.waitForExit(15_000).catch(() => {});
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${server.url}/health`)).ok) return;
    } catch {
      // still down
    }
    if (Date.now() > deadline) throw new Error("daemon did not come back");
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("the saved policy is the policy in force", () => {
  beforeAll(async () => {
    cloud = await startFakeCloud();
    serverA = await startLocalDataServer({
      config: serverConfig(cloud.url),
      auth: { idToken: fakeIdToken() },
    });
    // B boots with a policy that keeps everything, so the tightening below is
    // the only thing that could change its behaviour.
    serverB = await startLocalDataServer({
      config: serverConfig(cloud.url, { retention: keepEverything }),
      auth: { idToken: fakeIdToken() },
    });
    driveA = await builtinAppCreds(serverA, "starkeep-drive");
    driveB = await builtinAppCreds(serverB, "starkeep-drive");
  }, 90_000);

  afterAll(async () => {
    await serverA?.stop();
    await serverB?.stop();
    await cloud?.close();
  });

  it("fetches under the booted policy, then declines under the saved one", { timeout: 120_000 }, async () => {
    // Baseline. Without it, the refusal below could just as easily be a broken
    // channel as an enforced policy.
    const before = (await createRecordWithBytes(driveA, {
      bytes: "in-force-before",
      fileName: "before.jpg",
    })).record;
    await converge();
    await eventually(async () => {
      expect(await hasBytes(driveB, before.id)).toBe(true);
    });

    const res = await fetch(`${serverB.url}/residency/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention: refuseImages }),
    });
    expect(res.status).toBe(200);
    await waitForRestart(serverB);
    driveB = await builtinAppCreds(serverB, "starkeep-drive");

    const after = (await createRecordWithBytes(driveA, {
      bytes: "in-force-after",
      fileName: "after.jpg",
    })).record;
    await converge();

    // The record arrives — this is an elision, not a channel that stopped
    // working. Distinguishing the two is the whole content of the assertion:
    // a node that had simply stopped syncing would also be missing the bytes.
    await eventually(async () => {
      expect(await hasRecord(driveB, after.id)).toBe(true);
    });
    expect(
      await hasBytes(driveB, after.id),
      "the rebuilt manager is still deciding by the booted policy",
    ).toBe(false);

    // And the bytes that were already here are not retroactively removed:
    // saving a policy arms eviction, it does not perform one.
    expect(await hasBytes(driveB, before.id)).toBe(true);
  });
});

describe("an app installed after boot", () => {
  let server: LocalDataServer;
  let app: InstalledApp;

  beforeAll(async () => {
    server = await startLocalDataServer({ config: { retention: keepEverything } });
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("classifies its derivatives under its own ladder, not as unclassified", async () => {
    // `sizeClassKeys` is read once at boot and mutated in place on every
    // registry change, precisely so the objects that closed over it — the
    // residency manager and the census — see an app installed later. Observed
    // through the census, which reads the same map: an install that failed to
    // refresh it would put this record under `testapp:unclassified`, and the
    // resident-set rows written while that was true would keep that class
    // permanently, since nothing reclassifies them.
    app = await installApp(
      server,
      testAppManifest({
        infraRequirements: {
          ...(testAppManifest().infraRequirements as Record<string, unknown>),
          labelKeys: [{ key: "rendition", description: "which rung", sizeClass: true }],
        },
      }),
    );
    // A derivative, not an original: the ladder only applies to records that
    // have a parent, since an original's class comes from its type.
    const { record: original } = await createRecordWithBytes(app, {
      bytes: Buffer.alloc(8192),
      fileName: "original.jpg",
    });
    const { record } = await createRecordWithBytes(app, {
      bytes: Buffer.alloc(4096),
      fileName: "thumb.jpg",
      parentId: original.id,
      labels: [{ key: "rendition", value: "thumb" }],
    });
    expect(record.id).toBeTruthy();

    const res = await fetch(`${server.url}/residency/projection`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      census: Array<{ sizeClass: string; totalBytes: number }>;
    };
    const classes = body.census.map((c) => c.sizeClass);
    expect(classes, `census was ${JSON.stringify(classes)}`).toContain("testapp:thumb");
    expect(classes).not.toContain("testapp:unclassified");
  }, 60_000);
});
