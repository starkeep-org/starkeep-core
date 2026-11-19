import { describe, it, expect } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { getFreePort, startLocalDataServer } from "../../src/local-data-server.js";

/** Holds a loopback port, as another process in a parallel test run would. */
async function occupyPort(): Promise<{ port: number; release(): Promise<void> }> {
  const holder: Server = createServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const address = holder.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    release: () => new Promise((resolve) => holder.close(() => resolve())),
  };
}

// Boots a real server process per test, so this file is the harness's own
// smoke coverage; the broad route assertions live in the local-data-server's
// Tier-1 suite.
describe("local-data-server harness", () => {
  it("boots against an empty STARKEEP_DIR (fresh-machine path) and tears down", async () => {
    const server = await startLocalDataServer();
    try {
      const health = await fetch(`${server.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok" });

      // First boot persists a generated nodeId.
      const config = JSON.parse(await readFile(join(server.starkeepDir, "config.json"), "utf8"));
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
      const config = JSON.parse(await readFile(join(first.starkeepDir, "config.json"), "utf8"));
      expect(config.pullIntervalMs).toBe(1234);
      expect(config.nodeId).toMatch(/^test-/);
    } finally {
      await first.stopKeepData();
    }

    // Same dir can be re-used for a restart (durability tests rely on this).
    const second = await startLocalDataServer({ starkeepDir: first.starkeepDir });
    try {
      const config = JSON.parse(await readFile(join(second.starkeepDir, "config.json"), "utf8"));
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

  it("retries on a fresh port when another process takes the ephemeral one first", async () => {
    const taken = await occupyPort();
    const picked: number[] = [];
    try {
      const server = await startLocalDataServer({
        pickPort: async () => {
          const port = picked.length === 0 ? taken.port : await getFreePort();
          picked.push(port);
          return port;
        },
      });
      try {
        expect(picked[0]).toBe(taken.port);
        expect(picked).toHaveLength(2);
        expect(server.port).toBe(picked[1]);
        expect((await fetch(`${server.url}/health`)).status).toBe(200);
      } finally {
        await server.stop();
      }
    } finally {
      await taken.release();
    }
  }, 60_000);

  it("fails fast with the crash output when a fixed port is taken", async () => {
    const taken = await occupyPort();
    try {
      const started = Date.now();
      await expect(startLocalDataServer({ port: taken.port })).rejects.toThrow(
        /exited \(code 1.*before becoming healthy[\s\S]*EADDRINUSE/,
      );
      // Well under the 30 s start timeout: the harness saw the child die.
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await taken.release();
    }
  }, 30_000);
});
