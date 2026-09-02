/**
 * Shutdown has to drain the HLC clock *before* it closes the database.
 *
 * The clock's write-back is debounced by five seconds, so at any moment the
 * newest timestamps this node has issued exist only in memory. `nodeClock.close()`
 * is what forces them out, and it writes through `syncStateStore` — which holds
 * the same raw SQLite handle that `sdk.close()` closes. Run the two in the wrong
 * order and the flush prepares a statement against a closed database.
 *
 * That fails twice over. The clock state is lost, so a restart can resume behind
 * timestamps this node already emitted. And the rejection propagates out of the
 * shutdown handler before `process.exit(0)`, so the process never exits — the
 * SSE keep-alive interval holds the event loop open — and SIGTERM stops being
 * able to stop the daemon at all.
 *
 * Both halves are asserted here because the second is the one an operator
 * notices and the first is the one that corrupts data.
 */
import { describe, it, expect, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { installApp, testAppManifest, createRecordWithBytes } from "./helpers.js";

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** The persisted clock state, or null when shutdown never wrote one. */
function persistedClockState(
  starkeepDir: string,
): { wallTime: number; counter: number } | null {
  const db = new DatabaseSync(join(starkeepDir, "data.db"), { readOnly: true });
  try {
    const row = db
      .prepare("SELECT value_json FROM sync_state WHERE key = ?")
      .get("hlc_clock") as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as { wallTime: number; counter: number }) : null;
  } finally {
    db.close();
  }
}

describe("SIGTERM drains the HLC clock before closing the database", () => {
  it("exits cleanly and leaves the clock state on disk", async () => {
    // A cloud URL is what gives the server a sync state store, and the store is
    // what the clock persists through — without one there is nothing to flush
    // and nothing to get the ordering wrong. It never has to answer: the pull
    // interval is long enough that no exchange is attempted during the test.
    const server: LocalDataServer = await startLocalDataServer({
      config: { apiGatewayUrl: "http://127.0.0.1:1/unused", pullIntervalMs: 600_000 },
    });
    dirs.push(server.starkeepDir);

    const app = await installApp(server, testAppManifest());
    // Writing a record ticks the clock, so there is pending state to lose.
    const before = Date.now();
    await createRecordWithBytes(app, { bytes: "clock-flush" });

    // Signal well inside the five-second debounce, so the state being asserted
    // below can only have reached disk through the shutdown flush.
    server.child.kill("SIGTERM");
    const code = await server.waitForExit(15_000);

    // `process.exit(0)` at the end of the handler. A throw before it leaves the
    // process alive on its keep-alive interval instead.
    expect(code).toBe(0);

    const state = persistedClockState(server.starkeepDir);
    expect(state).not.toBeNull();
    // At or past the write, which is what makes a restart resume causally after
    // everything this node already emitted.
    expect(state!.wallTime).toBeGreaterThanOrEqual(before);
  });
});
