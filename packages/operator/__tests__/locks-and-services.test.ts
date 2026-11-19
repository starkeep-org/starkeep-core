import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "operator-locks-"));
process.env.STARKEEP_DIR = dir;

let locks: typeof import("../src/locks");
let services: typeof import("../src/services");
beforeAll(async () => {
  locks = await import("../src/locks");
  services = await import("../src/services");
});

describe("locks", () => {
  it("lets one holder in and names it to the next", () => {
    const first = locks.acquireLock("platform", "first");
    expect(first.ok).toBe(true);
    const second = locks.acquireLock("platform", "second");
    expect(second).toMatchObject({ ok: false, holder: { pid: process.pid, command: "first" } });
    if (first.ok) first.release();
    const third = locks.acquireLock("platform", "third");
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
  });

  it("takes over a lock whose holder died", () => {
    mkdirSync(join(dir, "locks"), { recursive: true });
    // A pid far above any real one stands for a process that is gone.
    writeFileSync(
      locks.lockFile("app-notes"),
      JSON.stringify({ pid: 99_999_999, command: "crashed", since: "" }),
    );
    expect(locks.lockHolder("app-notes")).toBeNull();
    const taken = locks.acquireLock("app-notes", "next");
    expect(taken.ok).toBe(true);
    if (taken.ok) taken.release();
  });

  it("refuses a scope that could leave the locks folder", () => {
    expect(() => locks.lockFile("../x")).toThrow(/Invalid lock scope/);
  });
});

describe("services.json", () => {
  it("records the services the person wants running, once each, in order", () => {
    expect(services.wantedServices()).toEqual([]);
    services.recordWanted("local-data-server", true);
    services.recordWanted("photos", true);
    services.recordWanted("photos", true);
    expect(services.wantedServices()).toEqual(["local-data-server", "photos"]);
    services.recordWanted("photos", false);
    expect(services.wantedServices()).toEqual(["local-data-server"]);
  });

  it("reads a damaged file as empty", () => {
    writeFileSync(services.servicesFile(), "{not json");
    expect(services.wantedServices()).toEqual([]);
  });
});
