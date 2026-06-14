/**
 * Tier-1 events + config/lifecycle: the /events SSE contract (payload-less
 * kicks) and the fresh-boot / PATCH-config-restart lifecycle.
 * (Plan §3 "Events" and "Config & lifecycle".)
 *
 * The SSE kick on a sync-applied *remote* change is asserted in
 * sync-over-wire.test.ts, where a second server provides the remote side.
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  installApp,
  testAppManifest,
  createRecordWithBytes,
  eventually,
  openSse,
} from "./helpers.js";

const execFileAsync = promisify(execFile);

describe("/events SSE", () => {
  let server: LocalDataServer;

  afterAll(async () => {
    await server?.stop();
  });

  it("delivers a payload-empty kick on a local write", async () => {
    server = await startLocalDataServer();
    const app = await installApp(server, testAppManifest());

    const sse = openSse(`${server.url}/events`);
    try {
      // Connection preamble arrives before any write.
      await eventually(() => {
        expect(sse.comments).toContain("connected");
      });
      expect(sse.dataEvents).toEqual([]);

      await createRecordWithBytes(app, { type: "jpg" });

      await eventually(() => {
        expect(sse.dataEvents.length).toBeGreaterThan(0);
      });
      // The tightened post-review contract: a kick carries no record-shaped
      // information — every data payload is the empty string.
      expect(sse.dataEvents.every((d) => d === "")).toBe(true);
    } finally {
      await sse.close();
    }
  });
});

describe("config & lifecycle", () => {
  it("boots against an empty STARKEEP_DIR and generates a nodeId config", async () => {
    const server = await startLocalDataServer();
    try {
      const health = await fetch(`${server.url}/health`);
      expect(health.status).toBe(200);

      // First boot wrote config.json with a generated nodeId and no cloud config.
      const config = JSON.parse(
        await readFile(join(server.starkeepDir, "config.json"), "utf8"),
      ) as { nodeId?: string };
      expect(config.nodeId).toBeTruthy();

      const apiConfig = (await (await fetch(`${server.url}/config`)).json()) as {
        stage: string | null;
        apiGatewayUrl: string | null;
        cognitoConfig: unknown;
      };
      expect(apiConfig.stage).toBeNull();
      expect(apiConfig.apiGatewayUrl).toBeNull();
      expect(apiConfig.cognitoConfig).toBeNull();
    } finally {
      await server.stop();
    }
  });

  it("PATCH /config persists the patch, exits, and the replacement respawns serving it", { timeout: 30_000 }, async () => {
    const server = await startLocalDataServer();
    const { port, starkeepDir } = server;
    try {
      const originalNodeId = (
        JSON.parse(await readFile(join(starkeepDir, "config.json"), "utf8")) as {
          nodeId: string;
        }
      ).nodeId;

      const res = await fetch(`${server.url}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "patched-stage", nodeId: "must-not-change" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      // The serving process exits to apply the change…
      const exitCode = await server.waitForExit(10_000);
      expect(exitCode).toBe(0);

      // The patch is on disk, with nodeId immutable.
      const onDisk = JSON.parse(
        await readFile(join(starkeepDir, "config.json"), "utf8"),
      ) as { stage?: string; nodeId: string };
      expect(onDisk.stage).toBe("patched-stage");
      expect(onDisk.nodeId).toBe(originalNodeId);

      // …and the detached replacement restartProcess spawns comes back up on
      // the same port, serving the patched config. restartProcess now re-execs
      // with process.execArgv, so the tsx loader survives the respawn (it did
      // not before — the replacement crashed with ERR_MODULE_NOT_FOUND).
      // The respawn boots into an append-only log file; assert it reached the
      // "listening" line (a missing loader would instead log
      // ERR_MODULE_NOT_FOUND and never bind).
      const logPath = join(starkeepDir, "local-data-server.log");
      const booted = await eventually(
        async () => {
          const log = await readFile(logPath, "utf8");
          expect(log).toMatch(/listening on|ERR_MODULE_NOT_FOUND/);
          return log;
        },
        { timeoutMs: 15_000 },
      );
      expect(booted).not.toMatch(/ERR_MODULE_NOT_FOUND/);
      expect(booted).toMatch(/listening on/);
    } finally {
      // Reap the detached replacement now holding the port.
      try {
        const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`]);
        for (const pid of stdout.trim().split("\n").filter(Boolean)) {
          process.kill(Number(pid), "SIGTERM");
        }
      } catch {
        // Nothing listening — already gone.
      }
      await server.stop();
    }
  });
});
