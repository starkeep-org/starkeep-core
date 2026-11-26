/**
 * Uninstalling an app on this computer, against a stand-in local data server.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeDataDir } from "./helpers";

process.env.STARKEEP_DIR = makeDataDir("operator-local-apps-");

let localApps: typeof import("../src/local-apps");
let services: typeof import("../src/services");
beforeAll(async () => {
  localApps = await import("../src/local-apps");
  services = await import("../src/services");
});
afterEach(() => vi.unstubAllGlobals());

describe("uninstallLocalApp", () => {
  it("clears the app's mark to run, so a later start with no names leaves it alone", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    services.recordWanted("local-data-server", true);
    services.recordWanted("dice", true);
    expect(await localApps.uninstallLocalApp("dice")).toEqual({ ok: true });
    expect(services.wantedServices()).toEqual(["local-data-server"]);
  });

  it("keeps the mark when the data server refuses the uninstall", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 500 }));
    services.recordWanted("notes", true);
    expect(await localApps.uninstallLocalApp("notes")).toMatchObject({ ok: false, status: 500 });
    expect(services.wantedServices()).toContain("notes");
  });
});
