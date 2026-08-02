/**
 * `GET /residency/projection` through a running server.
 *
 * The census and the projection are unit-tested apart; this is the layer where
 * a wiring mistake — a census built with the wrong label, a projection run
 * against a policy the server never loaded — passes both of those and still
 * gives an operator the wrong number to size a disk by.
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

interface ProjectionResponse {
  configured: boolean;
  census: Array<{ sizeClass: string; recordCount: number; totalBytes: number }>;
  totalLibraryBytes?: number;
  projection?: {
    rows: Array<{ sizeClass: string; projectedBytes: number; overBudget: boolean }>;
    totalProjectedBytes: number;
    overBudgetClasses: string[];
  };
}

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(server, testAppManifest());
}, 60_000);

afterAll(async () => {
  await server.stop();
});

const fetchProjection = async (): Promise<ProjectionResponse> => {
  const res = await fetch(`${server.url}/residency/projection`);
  expect(res.status).toBe(200);
  return (await res.json()) as ProjectionResponse;
};

describe("with no retention policy configured", () => {
  // An unconfigured node wants every blob — so the honest projection is the
  // whole library. Reporting an empty table would read as "nothing here", which
  // is the opposite of the truth.
  it("reports the census and says no policy is configured", async () => {
    await createRecordWithBytes(app, { bytes: Buffer.alloc(4096), fileName: "a.jpg" });
    const body = await fetchProjection();

    expect(body.configured).toBe(false);
    expect(body.projection).toBeUndefined();
    expect(body.census.length).toBeGreaterThan(0);
    expect(body.totalLibraryBytes).toBeGreaterThan(0);
  });

  // The largest class in any library, and the one an inner join would drop.
  it("counts unlabelled records as originals", async () => {
    const body = await fetchProjection();
    const originals = body.census.filter((c) => c.sizeClass.startsWith("original:"));
    expect(originals.length).toBeGreaterThan(0);
    expect(originals[0]!.totalBytes).toBeGreaterThan(0);
  });
});

describe("the census reflects what was actually written", () => {
  it("grows when a record is added", async () => {
    const before = await fetchProjection();
    const beforeBytes = before.census.reduce((s, c) => s + c.totalBytes, 0);

    await createRecordWithBytes(app, { bytes: Buffer.alloc(8192), fileName: "b.jpg" });

    const after = await fetchProjection();
    const afterBytes = after.census.reduce((s, c) => s + c.totalBytes, 0);
    expect(afterBytes).toBeGreaterThan(beforeBytes);
  });

  // Loopback-gated rather than app-gated: it is a fact about the machine, not
  // about anybody's library, and an app has no business asking.
  it("answers without app authentication", async () => {
    const res = await fetch(`${server.url}/residency/projection`);
    expect(res.status).toBe(200);
  });
});

describe("with a retention policy configured", () => {
  let configured: LocalDataServer;
  let configuredApp: InstalledApp;

  beforeAll(async () => {
    configured = await startLocalDataServer({
      config: {
        retention: {
          rows: {
            // Tiny budget against a class that will exceed it, so the
            // over-budget path is exercised rather than merely present.
            "original:image": { keep: "all", budgetBytes: 1024 },
          },
          fallback: { keep: "never", budgetBytes: 1024 },
        },
      },
    });
    configuredApp = await installApp(configured, testAppManifest());
    await createRecordWithBytes(configuredApp, {
      bytes: Buffer.alloc(64 * 1024),
      fileName: "big.jpg",
    });
  }, 60_000);

  afterAll(async () => {
    await configured.stop();
  });

  it("projects the configured policy against the real census", async () => {
    const res = await fetch(`${configured.url}/residency/projection`);
    const body = (await res.json()) as ProjectionResponse;

    expect(body.configured).toBe(true);
    expect(body.projection).toBeDefined();
    const row = body.projection!.rows.find((r) => r.sizeClass === "original:image")!;
    // Capped at the budget, and flagged — the flag is what tells the operator
    // eviction will run continuously against this row, so what they asked for
    // is not what they will get.
    expect(row.projectedBytes).toBe(1024);
    expect(row.overBudget).toBe(true);
    expect(body.projection!.overBudgetClasses).toContain("original:image");
  });
});
