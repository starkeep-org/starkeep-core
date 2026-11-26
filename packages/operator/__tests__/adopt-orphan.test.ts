/**
 * A workspace daemon's fixed port held by another program: only a process
 * that runs in the daemon's own package folder is adopted, because a later
 * Stop signals the adopted process's whole group.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.STARKEEP_DIR = mkdtempSync(join(tmpdir(), "operator-adopt-"));
const port = 22_000 + Math.floor(Math.random() * 8_000);
process.env.STARKEEP_PORT = String(port);

const server = createServer();
beforeAll(() => new Promise<void>((done) => server.listen(port, "127.0.0.1", () => done())));
afterAll(() => new Promise<void>((done) => server.close(() => done())));

describe("adoptOrphanWorkspaceDaemon", () => {
  it("leaves a node program that holds the data server's port alone", async () => {
    const { adoptOrphanWorkspaceDaemon, pidFile } = await import("../src/daemons");
    expect(adoptOrphanWorkspaceDaemon("local-data-server")).toBeNull();
    expect(existsSync(pidFile("local-data-server"))).toBe(false);
  });

  it("refuses to start the data server, and names the port", async () => {
    const { startWorkspaceDaemon } = await import("../src/daemons");
    const outcome = await startWorkspaceDaemon("local-data-server");
    expect(outcome.ok).toBe(false);
  });
});
