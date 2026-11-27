/**
 * The cloud targets of `install`, `uninstall`, `list` and `update`, at the CLI
 * layer: a real local data server and stand-in apps in git repositories, and
 * a stand-in for the cloud module, which records each cloud run instead of
 * deploying. The operations behind the runs have their own tests, and tier 3
 * drives a real one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answering,
  result,
  root,
  standInRepo,
  starkeep,
  writeStandIn,
  type StandInRepo,
} from "./harness";

interface Run {
  name: string;
  input: Record<string, unknown>;
  owner: string;
  lock: string;
  command: string;
}

const cloud = vi.hoisted(() => ({
  apps: [] as Array<Record<string, unknown>>,
  runs: [] as Run[],
  /** The run name that fails, if any. */
  fail: null as string | null,
  /** The order of cloud runs and local steps, as the output shows them. */
  timeline: [] as string[],
  /** Whether an admin session is open, so the cloud's apps can be read. */
  signedIn: true,
}));

vi.mock("../../src/cloud", async (original) => {
  const real = await original<typeof import("../../src/cloud")>();
  const { CliError } = await import("../../src/errors");
  return {
    ...real,
    cloudInstalled: () => true,
    readCloudApps: async () => (cloud.signedIn ? cloud.apps : null),
    runCloud: async (io: { event: (e: unknown) => void }, run: Run) => {
      cloud.runs.push(run);
      cloud.timeline.push(`cloud:${run.name}`);
      io.event({ type: "progress", message: `[cloud run] ${run.name}` });
      if (cloud.fail === run.name) throw new CliError("The cloud refused the deploy.");
      return {};
    },
  };
});

const apps = join(root, "apps");
let dice: StandInRepo;

function deployedManifest(appId: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(apps, appId, "starkeep.manifest.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/** A cloud registry row for `appId`, compared with its folder as `listCloudApps` does. */
function cloudRow(appId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId,
    version: "0.1.0",
    name: appId,
    installedAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
    webApp: true,
    mobileApp: false,
    // The deployed manifest: the folder's own, as after a deploy from it.
    manifest: deployedManifest(appId),
    behind: false,
    codeBehind: false,
    folder: join(apps, appId),
    ...extra,
  };
}

async function quietly(args: string[]) {
  const { main } = await import("../../src/main");
  let out = "";
  let err = "";
  const code = await main(args, {
    cwd: root,
    interactive: false,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

beforeAll(() => {
  dice = standInRepo(apps, "dice");
  writeStandIn(join(apps, "notes"), "notes");
  const setup = starkeep(["setup", "--local", "--yes", "--no-link", "--no-install"]);
  expect(setup.code, setup.err).toBe(0);
  expect(starkeep(["source", "add", apps]).code).toBe(0);
});

afterAll(() => {
  starkeep(["stop"]);
});

beforeEach(() => {
  cloud.apps = [];
  cloud.runs = [];
  cloud.fail = null;
  cloud.timeline = [];
  cloud.signedIn = true;
});

describe("install with a cloud target", () => {
  it.each([
    [["--cloud"], undefined],
    [["--web"], ["web"]],
    [["--mobile"], ["mobile"]],
  ])("asks once and installs the surfaces %s names (APP-LIFE-112)", async (flags, surfaces) => {
    const run = await answering(["install", "notes", ...flags], ["y"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("Install Notes in the cloud?");
    expect(run.err.match(/Approve and install\? \[y\/N\]/g)).toHaveLength(1);
    expect(cloud.runs).toHaveLength(1);
    expect(cloud.runs[0]).toMatchObject({ name: "install-cloud-app", lock: "app-notes" });
    expect(cloud.runs[0]!.input.surfaces).toEqual(surfaces);
    expect(typeof cloud.runs[0]!.input.manifestDigest).toBe("string");
  });

  it("stops with status 3 before any deploy when no terminal can approve (APP-LIFE-247)", async () => {
    const run = await quietly(["install", "notes", "--cloud"]);
    expect(run.code).toBe(3);
    expect(run.err).toContain("Pass --yes to approve.");
    expect(cloud.runs).toHaveLength(0);
  });

  it("installs in the cloud first, then on this computer, with one consent (APP-LIFE-245)", async () => {
    const run = await answering(["install", "dice", "--local", "--cloud"], ["y", "n"]);
    expect(run.code, run.err).toBe(0);
    expect(run.err.match(/Approve and install\? \[y\/N\]/g)).toHaveLength(1);
    const cloudAt = run.out.indexOf("[cloud run] install-cloud-app");
    const localAt = run.out.indexOf("Installing Dice on this computer…");
    expect(cloudAt).toBeGreaterThanOrEqual(0);
    expect(localAt).toBeGreaterThan(cloudAt);
    expect(run.out.indexOf("Installed Dice.")).toBeGreaterThan(localAt);
    expect(cloud.runs[0]!.command).toBe("starkeep install dice --cloud");
  });

  it("leaves this computer as it was when the cloud step fails", async () => {
    cloud.fail = "install-cloud-app";
    const run = await quietly(["install", "notes", "--local", "--cloud", "--yes"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("The cloud refused the deploy.");
    expect(run.out).not.toContain("Installing Notes on this computer");
    const list = result(starkeep(["list", "--json"]).out).data!.apps as Array<{
      appId: string;
      local: string;
    }>;
    expect(list.find((a) => a.appId === "notes")?.local).toBe("not installed");
  });
});

describe("the list's cloud column", () => {
  it("shows each app's surfaces and which are behind, with a row for a cloud-only app (APP-LIFE-252)", async () => {
    cloud.apps = [
      cloudRow("dice", { mobileApp: true, codeBehind: true }),
      cloudRow("notes", { webApp: false }),
      cloudRow("ghost", { folder: null }),
    ];
    const run = await quietly(["list"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toMatch(/^APP +SOURCE +LOCAL +CLOUD$/m);
    expect(run.out).toMatch(/^dice .* web\+mobile {2}\(behind\)$/m);
    expect(run.out).toMatch(/^notes .* data$/m);
    expect(run.out).toMatch(/^ghost /m);
  });
});

describe("the list without an admin session", () => {
  it("shows ? in the cloud column and warns, with no sign-in (APP-LIFE-253)", async () => {
    cloud.signedIn = false;
    const run = await quietly(["list"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toMatch(/^dice .* \?$/m);
    expect(run.out).toMatch(/^notes .* \?$/m);
    expect(run.err).toContain("Sign in with `starkeep login --admin` to see the CLOUD column.");
  });
});

describe("uninstall with a cloud target", () => {
  it("says an app the cloud does not hold is not installed there (APP-LIFE-254)", async () => {
    const run = await quietly(["uninstall", "notes", "--cloud"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("notes is not installed in the cloud.");
    expect(cloud.runs).toHaveLength(0);
  });

  it("removes the app from the cloud and keeps its data (APP-LIFE-153)", async () => {
    cloud.apps = [cloudRow("notes")];
    const run = await quietly(["uninstall", "notes", "--cloud"]);
    expect(run.code, run.err).toBe(0);
    expect(cloud.runs.map((r) => r.name)).toEqual(["uninstall-cloud-app"]);
  });

  it("asks for the id before any change, and a mismatch removes nothing", async () => {
    cloud.apps = [cloudRow("dice")];
    const run = await answering(
      ["uninstall", "dice", "--local", "--cloud", "--delete-data"],
      ["nope"],
    );
    expect(run.code).toBe(1);
    expect(run.err).toContain("Type dice to delete its data on this computer and in the cloud:");
    expect(run.err).toContain(
      "Nothing changed: the typed id did not match, so dice stays installed with its data.",
    );
    expect(cloud.runs).toHaveLength(0);
    const list = result(starkeep(["list", "--json"]).out).data!.apps as Array<{
      appId: string;
      local: string;
    }>;
    expect(list.find((a) => a.appId === "dice")?.local).toBe("installed");
  });

  it("deletes cloud data without a terminal only with --yes (APP-LIFE-162)", async () => {
    cloud.apps = [cloudRow("notes")];
    const run = await quietly(["uninstall", "notes", "--cloud", "--delete-data"]);
    expect(run.code).toBe(3);
    expect(run.err).toContain(
      "Type the app id to delete its data. No terminal is attached to answer. Pass --yes to delete without typing the app id.",
    );
    expect(cloud.runs).toHaveLength(0);
    const yes = await quietly(["uninstall", "notes", "--cloud", "--delete-data", "--yes"]);
    expect(yes.code, yes.err).toBe(0);
    expect(cloud.runs.map((r) => r.name)).toEqual(["uninstall-cloud-app", "delete-app-data"]);
    expect(cloud.runs[1]!.input.confirm).toBe("notes");
  });

  it("previews the cloud data of an app the cloud no longer runs before it asks", async () => {
    const run = await answering(["uninstall", "notes", "--cloud", "--delete-data"], ["notes"]);
    expect(run.code, run.err).toBe(0);
    expect(cloud.runs.map((r) => [r.name, r.input.preview ?? r.input.confirm])).toEqual([
      ["delete-app-data", true],
      ["delete-app-data", "notes"],
    ]);
  });
});

describe("update with a cloud install", () => {
  it("updates the cloud first, then this computer (APP-LIFE-256)", async () => {
    dice.publish({ version: "v2" });
    cloud.apps = [cloudRow("dice")];
    const run = await quietly(["update", "dice"]);
    expect(run.code, run.err).toBe(0);
    const cloudAt = run.out.indexOf("Updating dice in the cloud (web)…");
    expect(cloudAt).toBeGreaterThanOrEqual(0);
    expect(run.out.indexOf("Updated dice.")).toBeGreaterThan(cloudAt);
    // The cloud read happened before the pull, so the pull forces the redeploy.
    expect(cloud.runs.map((r) => r.name)).toEqual(["install-cloud-app"]);
    expect(cloud.runs[0]!.input.surfaces).toEqual(["web"]);
  });

  it("spares a cloud install that already runs the folder (APP-LIFE-257)", async () => {
    cloud.apps = [cloudRow("dice")];
    const run = await quietly(["update", "dice", "--cloud", "--no-fetch"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("dice: the cloud already runs this folder.");
    expect(cloud.runs).toHaveLength(0);
  });

  it("redeploys only the surfaces the app has in the cloud (APP-LIFE-259)", async () => {
    cloud.apps = [cloudRow("dice", { behind: true, mobileApp: false })];
    const run = await quietly(["update", "dice", "--cloud", "--no-fetch"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("Updating dice in the cloud (web)…");
    expect(cloud.runs[0]!.input.surfaces).toEqual(["web"]);
  });

  it("names the folder a cloud-only app needs (APP-LIFE-260)", async () => {
    cloud.apps = [cloudRow("ghost", { folder: null })];
    const run = await quietly(["update", "ghost", "--cloud"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain(
      "ghost is installed in the cloud, but no discovery folder holds it. Add its folder with `starkeep source add <dir>`.",
    );
    expect(cloud.runs).toHaveLength(0);
  });

  it("updates only the cloud with --cloud, and only this computer with --local (APP-LIFE-261)", async () => {
    cloud.apps = [cloudRow("dice", { behind: true })];
    const onlyCloud = await quietly(["update", "dice", "--cloud", "--no-fetch"]);
    expect(onlyCloud.code, onlyCloud.err).toBe(0);
    expect(cloud.runs).toHaveLength(1);
    expect(onlyCloud.out).not.toContain("Updated dice.");
    cloud.runs = [];
    const onlyLocal = await quietly(["update", "dice", "--local", "--no-fetch"]);
    expect(onlyLocal.code, onlyLocal.err).toBe(0);
    expect(cloud.runs).toHaveLength(0);
  });

  it("asks before the pull when the cloud gets new access, and a no leaves both places and the folder (APP-LIFE-258)", async () => {
    const before = dice.head();
    dice.publish({ version: "v3", reads: ["image/png", "video/mp4"] });
    cloud.apps = [
      cloudRow("dice", {
        manifest: {
          id: "dice",
          infraRequirements: {
            fileAccess: [{ types: ["image/png"], access: "read", rationale: "x" }],
          },
        },
      }),
    ];
    const run = await answering(["update", "dice"], ["n"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(
      "dice's new version asks for different access here and in the cloud:",
    );
    expect(run.err).toContain("Approve dice's new access and update? [y/N]");
    expect(run.out).toContain("Not updated: dice.");
    expect(dice.head()).toBe(before);
    expect(cloud.runs).toHaveLength(0);
  });

  it("keeps this computer on the old version when the cloud deploy fails", async () => {
    cloud.apps = [cloudRow("dice", { behind: true })];
    cloud.fail = "install-cloud-app";
    const run = await quietly(["update", "dice", "--yes"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("The cloud refused the deploy.");
    expect(run.out).not.toContain("Updated dice.");
  });
});
