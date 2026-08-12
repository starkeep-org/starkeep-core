/**
 * Editing the retention policy: dry-run projection, and a validated save.
 *
 * The dry run is what makes the matrix editable. Every other shape is worse:
 * saving on each keystroke restarts the daemon repeatedly, and projecting
 * client-side would duplicate the rules that decide residency — so the preview
 * could disagree with what actually happens, which is the one thing a preview
 * must never do.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  installApp,
  testAppManifest,
  createRecordWithBytes,
  type InstalledApp,
} from "./helpers.js";

let server: LocalDataServer;
let app: InstalledApp;

const GB = 1024 ** 3;

const validPolicy = {
  platform: {
    rows: { "original:image": { prefetch: true, share: 100 } },
    fallback: { prefetch: false, share: 1 },
    budgetBytes: 10 * GB,
  },
  apps: {},
  appFallback: { rows: {}, fallback: { prefetch: false, share: 1 }, budgetBytes: GB },
};

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(server, testAppManifest());
  await createRecordWithBytes(app, { bytes: Buffer.alloc(32 * 1024), fileName: "a.jpg" });
}, 60_000);

afterAll(async () => {
  await server.stop();
});

const post = (body: unknown) =>
  fetch(`${server.url}/residency/projection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const put = (body: unknown) =>
  fetch(`${server.url}/residency/policy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("projecting a candidate policy without saving", () => {
  it("returns a projection for a policy that was never persisted", async () => {
    const res = await post({ retention: validPolicy });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      problems: string[];
      projection: { rows: Array<{ sizeClass: string; projectedBytes: number }> };
    };
    expect(body.problems).toEqual([]);
    expect(body.projection.rows.find((r) => r.sizeClass === "starkeep:original:image")).toBeDefined();

    // Still unconfigured — the dry run must not have written anything.
    const after = await fetch(`${server.url}/residency/projection`);
    expect(((await after.json()) as { configured: boolean }).configured).toBe(false);
  });

  it("shows a different projection for a tighter budget", async () => {
    const res = await post({
      // The namespace budget is the number an operator moves; the row's share
      // is unchanged, so its bytes follow the header rather than being set
      // beside it.
      retention: { ...validPolicy, platform: { ...validPolicy.platform, budgetBytes: 1024 } },
    });
    const body = (await res.json()) as {
      projection: { rows: Array<{ sizeClass: string; projectedBytes: number; overBudget: boolean }> };
    };
    const row = body.projection.rows.find((r) => r.sizeClass === "starkeep:original:image")!;
    // 100 of the 101 shares in the platform namespace — the pooled fallback
    // holds the other one. Not 1024: a row's budget is its slice of the
    // namespace, and asserting the whole number here would be asserting that
    // the fallback line does not exist.
    expect(row.projectedBytes).toBe(Math.floor((1024 * 100) / 101));
    expect(row.overBudget).toBe(true);
  });

  // An operator mid-edit has an invalid policy more often than not, and
  // blanking the numbers while they fix it removes the very feedback they are
  // editing against.
  it("still projects an invalid policy, reporting the problems alongside", async () => {
    const res = await post({
      retention: { ...validPolicy, platform: { ...validPolicy.platform, budgetBytes: 0 } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { problems: string[]; projection: unknown };
    expect(body.problems.length).toBeGreaterThan(0);
    expect(body.projection).toBeDefined();
  });

  it("rejects a request with no policy at all", async () => {
    expect((await post({})).status).toBe(400);
  });
});

describe("saving a policy", () => {
  // These are not style preferences. A zero namespace budget is a prohibition
  // on every rung, written in the one place an operator reading the rows will
  // not look — which is why validateRetentionPolicy exists, and why it went
  // uncalled on the write path until now.
  it("refuses a zero namespace budget rather than saving it with a warning", async () => {
    const res = await put({
      retention: { ...validPolicy, platform: { ...validPolicy.platform, budgetBytes: 0 } },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { problems: string[] };
    expect(body.problems.some((p) => /budgetBytes/.test(p))).toBe(true);
  });

  // A namespace whose shares are all zero divides a real budget into nothing.
  it("refuses a namespace where nothing claims a share", async () => {
    const res = await put({
      retention: {
        ...validPolicy,
        platform: {
          ...validPolicy.platform,
          rows: { "original:image": { prefetch: true, share: 0 } },
          fallback: { prefetch: false, share: 0 },
        },
      },
    });
    expect(res.status).toBe(422);
  });

  it("refuses an override rule that would match nothing", async () => {
    const res = await put({
      retention: validPolicy,
      overrideRules: [{ appId: "photos", key: "faces", value: "", effect: "pin" }],
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { problems: string[] }).problems[0]).toMatch(/omit it entirely/);
  });

  it("refuses a pin shadowed by an exclude on the same selector", async () => {
    const res = await put({
      retention: validPolicy,
      overrideRules: [
        { appId: "photos", key: "faces", value: "Alice", effect: "pin" },
        { appId: "photos", key: "faces", value: "Alice", effect: "exclude" },
      ],
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { problems: string[] }).problems.some((p) => /no effect/.test(p)))
      .toBe(true);
  });

  it("rejects a request with no policy", async () => {
    expect((await put({})).status).toBe(400);
  });
});

describe("a saved policy takes effect", () => {
  let saved: LocalDataServer;
  let savedApp: InstalledApp;

  beforeAll(async () => {
    saved = await startLocalDataServer();
    savedApp = await installApp(saved, testAppManifest());
    await createRecordWithBytes(savedApp, { bytes: Buffer.alloc(32 * 1024), fileName: "b.jpg" });
  }, 60_000);

  afterAll(async () => {
    await saved.stop();
  });

  it("persists and is reported as configured after the restart", async () => {
    const res = await fetch(`${saved.url}/residency/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        retention: validPolicy,
        overrideRules: [{ appId: "photos", key: "faces", value: "Alice", effect: "pin" }],
      }),
    });
    expect(res.status).toBe(200);

    // The daemon restarts to pick the policy up, so the next read has to wait
    // for it to come back rather than racing the shutdown.
    await saved.waitForExit(10_000).catch(() => {});
    const projection = await waitForConfigured(saved.url);
    expect(projection.configured).toBe(true);
  }, 60_000);
});

async function waitForConfigured(
  url: string,
  timeoutMs = 30_000,
): Promise<{ configured: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/residency/projection`);
      if (res.ok) {
        const body = (await res.json()) as { configured: boolean };
        if (body.configured) return body;
        last = body;
      }
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`policy never took effect; last response ${JSON.stringify(last)}`);
}
