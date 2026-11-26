/**
 * admin-web's local install and uninstall take the app's lock, the one the
 * CLI takes, so a terminal operation and an admin-web one never run on the
 * same app at once (APP-LIFE-223).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDataDir } from "./helpers";

const dataDir = makeDataDir("adminweb-lock-");
process.env.STARKEEP_DIR = dataDir;
// Nothing listens here: a request that got past the lock would fail differently.
process.env.STARKEEP_LOCAL_DATA_SERVER_URL = "http://127.0.0.1:1";

let holder: ChildProcess;
beforeAll(() => {
  holder = spawn("sleep", ["60"]);
  mkdirSync(join(dataDir, "locks"), { recursive: true });
  writeFileSync(
    join(dataDir, "locks", "app-dice.lock"),
    JSON.stringify({ pid: holder.pid, command: "starkeep update dice", since: "now" }),
  );
});
afterAll(() => {
  holder.kill();
});

function post(body: unknown): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the app lock in admin-web", () => {
  it("answers 409 and names the terminal command that holds the app, on uninstall", async () => {
    const { POST } = await import("../src/routes/apps-uninstall");
    const res = await POST(post({ appId: "dice" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      `Another operation on dice is running (pid ${holder.pid}: starkeep update dice). Try again once it ends.`,
    );
  });

  it("answers 409 on install too", async () => {
    const { POST } = await import("../src/routes/apps-install");
    const res = await POST(post({ appId: "dice", approvedManifest: {} }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("starkeep update dice");
  });

  it("releases the lock when the request ends, so the terminal can take it", async () => {
    holder.kill();
    await new Promise((r) => setTimeout(r, 200));
    const { POST } = await import("../src/routes/apps-uninstall");
    const res = await POST(post({ appId: "dice" }));
    expect(res.status).not.toBe(409);
    expect(existsSync(join(dataDir, "locks", "app-dice.lock"))).toBe(false);
  });
});
