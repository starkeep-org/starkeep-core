/**
 * `setup --cloud`'s phases, with stand-ins for AWS, the browser and the local
 * services. Each phase checks whether its work is done, so a second run after
 * any phase resumes after it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CreateStackCommand,
  DescribeStacksCommand,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { createIo } from "../src/io";
import type { CloudRun } from "../src/cloud";

const dir = mkdtempSync(join(tmpdir(), "cli-setup-cloud-"));
process.env.STARKEEP_DIR = dir;
const configPath = join(dir, "config.json");

const { setupCloud, DRIVE_APP_ID } = await import("../src/setup/cloud");
type Deps = import("../src/setup/cloud").CloudSetupDeps;

const STACK: Stack = {
  StackName: "home-bootstrap",
  StackStatus: "CREATE_COMPLETE",
  CreationTime: new Date(),
  Outputs: [
    ["UserPoolId", "us-east-2_abc"],
    ["UserPoolClientId", "admin-client"],
    ["DeviceUserPoolClientId", "device-client"],
    ["CognitoDomain", "home.auth.us-east-2.amazoncognito.com"],
    ["IdentityPoolId", "us-east-2:pool"],
  ].map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
};

const OPTIONS = {
  region: "us-east-2",
  prefix: "home",
  name: "Home",
  adminEmail: "me@example.com",
  apps: [] as string[],
  yes: true,
  noBrowser: true,
};

interface World {
  calls: string[];
  stackExists: boolean;
  account: string;
  signedIn: boolean;
  syncing: boolean;
  cloudApps: string[];
  /** The cloud address the running data server read at its start; undefined when it is down. */
  dataServerCloud: string | null | undefined;
  failAt?: string;
}

function depsFor(world: World): Deps {
  const step = (name: string) => {
    world.calls.push(name);
    if (world.failAt === name) throw new Error(`${name} failed`);
  };
  return {
    owner: {
      sts: {
        send: async () => ({
          Account: world.account,
          Arn: `arn:aws:iam::${world.account}:user/me`,
        }),
      } as never,
      cloudFormation: {
        send: async (command: unknown) => {
          if (command instanceof CreateStackCommand) {
            step("create-stack");
            world.stackExists = true;
            return {};
          }
          if (command instanceof DescribeStacksCommand) {
            if (!world.stackExists)
              throw Object.assign(new Error("does not exist"), { name: "ValidationError" });
            return { Stacks: [STACK] };
          }
          return {};
        },
      } as never,
      waitForCreate: async () => {},
    },
    adminSignedIn: () => world.signedIn,
    loginAdmin: async () => {
      step("login-admin");
      world.signedIn = true;
    },
    loginSync: async () => {
      step("login-sync");
      world.syncing = true;
    },
    runCloud: async (_io, run: CloudRun) => {
      step(run.name);
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      if (run.name === "install-cloud-data-server") {
        writeFileSync(
          configPath,
          JSON.stringify({
            ...config,
            apiGatewayUrl: "https://gw.example",
            auroraEndpoint: "x.dsql.us-east-2.on.aws",
            cloudAppsUserPoolClientId: "cloud-apps",
          }),
        );
      }
      if (run.name === "install-drive") world.cloudApps.push(DRIVE_APP_ID);
      return {};
    },
    cloudAppIds: async () => world.cloudApps,
    syncState: async () => (world.syncing ? "signed-in" : "signed-out"),
    dataServerCloudUrl: async () => world.dataServerCloud,
    startLocalServices: async (_io, restart) => {
      step(restart ? "restart-services" : "start-services");
      if (restart || world.dataServerCloud === undefined) {
        const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
        world.dataServerCloud = (config.apiGatewayUrl as string | undefined) ?? null;
      }
    },
    installApps: async (_io, apps) => step(`install-apps ${apps.join(",")}`),
  };
}

function freshWorld(): World {
  return {
    calls: [],
    stackExists: false,
    account: "123456789012",
    signedIn: false,
    syncing: false,
    cloudApps: [],
    dataServerCloud: null,
  };
}

const io = () =>
  createIo({ json: false, cwd: dir, interactive: false, stdout: () => {}, stderr: () => {} });

beforeEach(() => rmSync(configPath, { force: true }));
afterEach(() => rmSync(configPath, { force: true }));

describe("setup --cloud", () => {
  it("runs every phase in order on a bare account", async () => {
    const world = freshWorld();
    const { phases } = await setupCloud(
      io(),
      { ...OPTIONS, apps: ["example-app"] },
      depsFor(world),
    );
    expect(world.calls).toEqual([
      "create-stack",
      "login-admin",
      "install-cloud-data-server",
      "install-drive",
      "restart-services",
      "login-sync",
      "install-apps example-app",
    ]);
    expect(phases).toEqual([
      "bootstrap-created",
      "outputs-recorded",
      "admin-signed-in",
      "cloud-data-server",
      "drive",
      "local-services",
      "sync-signed-in",
      "apps",
    ]);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      stackPrefix: "home",
      accountId: "123456789012",
      deploymentName: "Home",
      userPoolId: "us-east-2_abc",
      deviceUserPoolClientId: "device-client",
      cognitoDomain: "home.auth.us-east-2.amazoncognito.com",
    });
  });

  it.each([
    [
      "login-admin",
      [
        "login-admin",
        "install-cloud-data-server",
        "install-drive",
        "restart-services",
        "login-sync",
      ],
    ],
    [
      "install-cloud-data-server",
      ["install-cloud-data-server", "install-drive", "restart-services", "login-sync"],
    ],
    ["install-drive", ["install-drive", "restart-services", "login-sync"]],
    ["login-sync", ["start-services", "login-sync"]],
  ])("resumes at %s after it failed", async (failAt, rerun) => {
    const world: World = { ...freshWorld(), failAt };
    await expect(setupCloud(io(), OPTIONS, depsFor(world))).rejects.toThrow(`${failAt} failed`);
    world.calls = [];
    delete world.failAt;
    await setupCloud(io(), OPTIONS, depsFor(world));
    expect(world.calls).toEqual(rerun);
  });

  it("restarts a data server that started before the cloud existed, though this run installed nothing", async () => {
    // The terminal closed while the Drive run finished on its own, before
    // setup restarted the data server.
    const world = freshWorld();
    const first = depsFor(world);
    await setupCloud(io(), OPTIONS, {
      ...first,
      startLocalServices: async () => {
        throw new Error("the terminal closed");
      },
    }).catch(() => undefined);
    expect(world.dataServerCloud).toBeNull();
    world.calls = [];
    await setupCloud(io(), OPTIONS, depsFor(world));
    expect(world.calls).toEqual(["restart-services", "login-sync"]);
  });

  it("does nothing again on a finished setup but check the local services", async () => {
    const world = freshWorld();
    await setupCloud(io(), OPTIONS, depsFor(world));
    world.calls = [];
    const { phases } = await setupCloud(io(), OPTIONS, depsFor(world));
    expect(world.calls).toEqual(["start-services"]);
    expect(phases).toEqual(["local-services"]);
  });

  it("uses an existing stack with the prefix instead of creating one", async () => {
    const world = { ...freshWorld(), stackExists: true };
    const { phases } = await setupCloud(io(), OPTIONS, depsFor(world));
    expect(world.calls).not.toContain("create-stack");
    expect(phases.slice(0, 2)).toEqual(["bootstrap-found", "outputs-recorded"]);
  });

  it("refuses credentials for another account than config.json names", async () => {
    writeFileSync(configPath, JSON.stringify({ accountId: "999999999999", appParentDirs: [] }));
    const world = freshWorld();
    await expect(setupCloud(io(), OPTIONS, depsFor(world))).rejects.toThrow(
      "config.json names account 999999999999",
    );
    expect(world.calls).toEqual([]);
  });

  it("asks for the region, the name and the admin's email before touching AWS", async () => {
    for (const missing of ["region", "name", "adminEmail"] as const) {
      const world = freshWorld();
      const { [missing]: _gone, ...rest } = OPTIONS;
      await expect(setupCloud(io(), rest, depsFor(world))).rejects.toMatchObject({ exitCode: 2 });
      expect(world.calls).toEqual([]);
    }
  });

  it("stops at the stack's creation without a terminal or --yes", async () => {
    const world = freshWorld();
    await expect(
      setupCloud(io(), { ...OPTIONS, yes: false }, depsFor(world)),
    ).rejects.toMatchObject({
      exitCode: 3,
    });
    expect(world.calls).toEqual([]);
  });

  it("refuses a prefix the template would refuse", async () => {
    const world = freshWorld();
    await expect(
      setupCloud(io(), { ...OPTIONS, prefix: "Home_1" }, depsFor(world)),
    ).rejects.toMatchObject({
      exitCode: 2,
    });
  });
});
