/**
 * `starkeep update --platform` after the pull: the services it restarts, the
 * bootstrap step, and when it redeploys the cloud data server and Drive.
 * The cloud runs, the bootstrap update and the services are stood in for.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "cli-update-platform-"));
process.env.STARKEEP_DIR = dir;

const state = vi.hoisted(() => ({
  runs: [] as { name: string; input: Record<string, unknown> }[],
  running: new Set<string>(),
  stopped: [] as string[],
  started: [] as string[],
  bootstrap: "no-changes" as string | Error,
  bootstrapApply: null as boolean | null,
  cloud: null as unknown,
}));

vi.mock("../src/cloud", async (original) => ({
  ...(await original<typeof import("../src/cloud")>()),
  cloudInstalled: () => true,
  runCloud: async (_io: unknown, run: { name: string; input: Record<string, unknown> }) => {
    state.runs.push({ name: run.name, input: run.input });
    return {};
  },
}));
vi.mock("../src/commands/cloud", async (original) => ({
  ...(await original<typeof import("../src/commands/cloud")>()),
  runBootstrapUpdate: async (_io: unknown, options: { apply: boolean }) => {
    state.bootstrapApply = options.apply;
    if (state.bootstrap instanceof Error) throw state.bootstrap;
    return state.bootstrap;
  },
  readCloudState: async () => state.cloud,
}));
vi.mock("@starkeep/operator/service-control", async (original) => ({
  ...(await original<typeof import("@starkeep/operator/service-control")>()),
  serviceStatus: async (id: string) => ({ running: state.running.has(id) }),
}));
vi.mock("@starkeep/operator/daemons", async (original) => ({
  ...(await original<typeof import("@starkeep/operator/daemons")>()),
  stopById: async (id: string) => {
    state.stopped.push(id);
    return { stopped: true };
  },
}));
vi.mock("../src/commands/services", async (original) => ({
  ...(await original<typeof import("../src/commands/services")>()),
  startOne: async (_io: unknown, id: string) => {
    state.started.push(id);
    return true;
  },
}));

const { applyPlatform } = await import("../src/commands/platform");
const { createIo } = await import("../src/io");

const RECORD = { commit: "abc", dirty: false, branch: "main", fingerprint: "f", deployedAt: "" };

function io() {
  let out = "";
  let err = "";
  return {
    handle: createIo({
      json: false,
      cwd: dir,
      interactive: false,
      stdout: (t) => void (out += t),
      stderr: (t) => void (err += t),
    }),
    out: () => out,
    err: () => err,
  };
}

const both = { local: true, cloud: true };

beforeEach(() => {
  state.runs = [];
  state.running = new Set();
  state.stopped = [];
  state.started = [];
  state.bootstrap = "no-changes";
  state.bootstrapApply = null;
  state.cloud = {
    platform: { kind: "behind", record: RECORD, cloudLacks: [{ commit: "def", subject: "s" }] },
    drive: true,
    apps: [],
  };
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ stackPrefix: "sk", userPoolId: "us-east-2_abc", deploymentName: "Home" }),
  );
});

describe("applyPlatform", () => {
  it("restarts the data server and Drive that were running, once the checkout moved", async () => {
    state.running = new Set(["local-data-server", "drive"]);
    const outcome = await applyPlatform(io().handle, {
      scope: both,
      yes: true,
      force: false,
      pulled: true,
      applyBootstrap: true,
    });
    expect(state.stopped).toEqual(["drive", "local-data-server"]);
    expect(state.started).toEqual(["local-data-server", "drive"]);
    expect(outcome.restarted).toEqual(["local-data-server", "drive"]);
  });

  it("restarts nothing when the checkout did not move", async () => {
    state.running = new Set(["local-data-server"]);
    await applyPlatform(io().handle, {
      scope: both,
      yes: true,
      force: false,
      pulled: false,
      applyBootstrap: true,
    });
    expect(state.stopped).toEqual([]);
  });

  it("redeploys a cloud data server behind the checkout, and leaves a current Drive alone", async () => {
    const outcome = await applyPlatform(io().handle, {
      scope: both,
      yes: true,
      force: false,
      pulled: false,
      applyBootstrap: true,
    });
    expect(state.runs).toEqual([{ name: "install-cloud-data-server", input: {} }]);
    expect(outcome).toMatchObject({ cloudDataServer: "redeployed", drive: "up to date" });
  });

  it("redeploys neither when both run this checkout's code", async () => {
    state.cloud = { platform: { kind: "current", record: RECORD }, drive: true, apps: [] };
    const t = io();
    const outcome = await applyPlatform(t.handle, {
      scope: both,
      yes: true,
      force: false,
      pulled: false,
      applyBootstrap: true,
    });
    expect(state.runs).toEqual([]);
    expect(outcome).toMatchObject({ cloudDataServer: "up to date", drive: "up to date" });
    expect(t.out() + t.err()).toContain("Cloud data server: current, abc (main).");
  });

  it("redeploys Drive alone when only its manifest changed", async () => {
    state.cloud = { platform: { kind: "current", record: RECORD }, drive: false, apps: [] };
    const t = io();
    await applyPlatform(t.handle, {
      scope: both,
      yes: true,
      force: false,
      pulled: false,
      applyBootstrap: true,
    });
    expect(state.runs.map((r) => r.name)).toEqual(["install-drive"]);
    expect(t.out() + t.err()).toContain("Redeploying Drive…");
    expect(t.out() + t.err()).not.toContain("Redeploying the cloud data server");
  });

  it("passes --force on as allowBackward", async () => {
    state.cloud = {
      platform: { kind: "ahead", record: RECORD, checkoutLacks: [{ commit: "x", subject: "s" }] },
      drive: true,
      apps: [],
    };
    await applyPlatform(io().handle, {
      scope: both,
      yes: true,
      force: true,
      pulled: false,
      applyBootstrap: true,
    });
    expect(state.runs).toEqual([
      { name: "install-cloud-data-server", input: { allowBackward: true } },
    ]);
  });

  it("goes on without the bootstrap step when the terminal has no AWS credentials, and says how to run it", async () => {
    state.bootstrap = new Error(
      "This terminal has no working AWS credentials (no profile). Sign in to the AWS account with `aws sso login`.",
    );
    const t = io();
    await applyPlatform(t.handle, {
      scope: both,
      yes: true,
      force: false,
      pulled: false,
      applyBootstrap: true,
    });
    expect(t.err()).toContain("Skipped the bootstrap stack");
    expect(t.err()).toContain("starkeep cloud bootstrap-update --apply");
    expect(state.runs.map((r) => r.name)).toEqual(["install-cloud-data-server"]);
  });

  it("stops before the cloud data server when the bootstrap update is declined", async () => {
    state.bootstrap = "declined";
    await expect(
      applyPlatform(io().handle, {
        scope: both,
        yes: false,
        force: false,
        pulled: false,
        applyBootstrap: true,
      }),
    ).rejects.toMatchObject({
      message:
        "The bootstrap update was declined, so the update stopped before the cloud data server.",
      exitCode: 1,
    });
    expect(state.runs).toEqual([]);
  });

  it("names a command that exists when the bootstrap update would replace a resource", async () => {
    const { ReplacementRefused } = await import("../src/commands/cloud");
    state.bootstrap = new ReplacementRefused(2);
    const failure = applyPlatform(io().handle, {
      scope: both,
      yes: true,
      force: false,
      pulled: false,
      applyBootstrap: true,
    });
    await expect(failure).rejects.toThrow(
      "Error: the change set removes or replaces 2 resource(s). Nothing was applied.\n" +
        "Review it with `starkeep cloud bootstrap-update`. If the change is intended, apply it with\n" +
        "`starkeep cloud bootstrap-update --apply --allow-replacement`, then run the update again.",
    );
    expect(state.runs).toEqual([]);
  });

  it("leaves the cloud alone under --local", async () => {
    await applyPlatform(io().handle, {
      scope: { local: true, cloud: false },
      yes: true,
      force: false,
      pulled: false,
      applyBootstrap: true,
    });
    expect(state.runs).toEqual([]);
  });

  it("refuses a cloud data server that runs commits this checkout lacks before announcing the redeploy", async () => {
    state.cloud = {
      platform: {
        kind: "ahead",
        record: RECORD,
        checkoutLacks: [{ commit: "1234567890ab", subject: "Feature work" }],
      },
      drive: true,
      apps: [],
    };
    const t = io();
    await expect(
      applyPlatform(t.handle, {
        scope: both,
        yes: true,
        force: false,
        pulled: false,
        applyBootstrap: true,
      }),
    ).rejects.toThrow(
      "The cloud data server runs 1 commit(s) that this checkout lacks:\n  12345678 Feature work\n" +
        "Deploying this checkout would remove them.",
    );
    expect(t.out() + t.err()).not.toContain("10 to 20 minutes");
    expect(state.runs).toEqual([]);
  });

  it("only previews the bootstrap change in an update of everything, and leaves the cloud redeploys for the owner (CLOUD-SETUP-170)", async () => {
    state.bootstrap = "previewed";
    const t = io();
    const outcome = await applyPlatform(t.handle, {
      scope: both,
      yes: true,
      force: false,
      pulled: false,
      applyBootstrap: false,
    });
    expect(state.bootstrapApply).toBe(false);
    expect(outcome).toMatchObject({ bootstrap: "previewed", cloudDataServer: "skipped" });
    expect(t.err()).toContain("Apply it with `starkeep update --platform`, or with");
    expect(t.err()).toContain(
      "`starkeep cloud bootstrap-update --apply`, then run the update again.",
    );
    expect(state.runs).toEqual([]);
  });

  it("goes on to the cloud in an update of everything when the bootstrap stack has no change", async () => {
    await applyPlatform(io().handle, {
      scope: both,
      yes: true,
      force: false,
      pulled: false,
      applyBootstrap: false,
    });
    expect(state.bootstrapApply).toBe(false);
    expect(state.runs.map((r) => r.name)).toEqual(["install-cloud-data-server"]);
  });

  it("restarts the services after a pull whose continued process stopped before the restart", async () => {
    const { markRestartPending } = await import("../src/commands/platform");
    markRestartPending();
    state.running = new Set(["local-data-server"]);
    const local = { local: true, cloud: false };
    await applyPlatform(io().handle, {
      scope: local,
      yes: true,
      force: false,
      pulled: false,
      applyBootstrap: true,
    });
    expect(state.started).toEqual(["local-data-server"]);
    state.started = [];
    await applyPlatform(io().handle, {
      scope: local,
      yes: true,
      force: false,
      pulled: false,
      applyBootstrap: true,
    });
    expect(state.started).toEqual([]);
  });
});
