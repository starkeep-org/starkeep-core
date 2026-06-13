import { describe, it, expect } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { startLocalDataServer } from "../src/local-data-server.js";

// Boots a real server process per test, so this file is the harness's own
// smoke coverage; the broad route assertions live in the local-data-server's
// Tier-1 suite.
describe("local-data-server harness", () => {
  it("boots against an empty STARKEEP_DIR (fresh-machine path) and tears down", async () => {
    const server = await startLocalDataServer();
    try {
      const health = await fetch(`${server.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      // First boot persists a generated nodeId.
      const config = JSON.parse(
        await readFile(join(server.starkeepDir, "config.json"), "utf8"),
      );
      expect(typeof config.nodeId).toBe("string");
      expect(config.nodeId.length).toBeGreaterThan(0);

      // SQLite DB and objects dir materialize under the temp dir.
      await expect(stat(join(server.starkeepDir, "data.db"))).resolves.toBeDefined();
    } finally {
      await server.stop();
    }
    // Temp dir removed on stop.
    await expect(stat(server.starkeepDir)).rejects.toThrow();
  }, 60_000);

  it("honors a pre-seeded config.json and keeps a caller-owned dir", async () => {
    const first = await startLocalDataServer({ config: { pullIntervalMs: 1234 } });
    try {
      const config = JSON.parse(
        await readFile(join(first.starkeepDir, "config.json"), "utf8"),
      );
      expect(config.pullIntervalMs).toBe(1234);
      expect(config.nodeId).toMatch(/^test-/);
    } finally {
      await first.stopKeepData();
    }

    // Same dir can be re-used for a restart (durability tests rely on this).
    const second = await startLocalDataServer({ starkeepDir: first.starkeepDir });
    try {
      const config = JSON.parse(
        await readFile(join(second.starkeepDir, "config.json"), "utf8"),
      );
      expect(config.nodeId).toMatch(/^test-/); // nodeId survives restarts
    } finally {
      await second.stop(); // does not own the dir → leaves it in place
    }
    await expect(stat(first.starkeepDir)).resolves.toBeDefined();
  }, 60_000);

  it("reports the child's output when the server fails to boot", async () => {
    await expect(
      startLocalDataServer({
        // Point STARKEEP_DIR at a path that cannot be a directory.
        starkeepDir: "/dev/null/not-a-dir",
        startTimeoutMs: 10_000,
      }),
    ).rejects.toThrow(/did not become healthy|not-a-dir/);
  }, 30_000);
});
