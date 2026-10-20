/**
 * GET and PUT /api/deployment-settings — the deployment's settings.
 *
 * Pins where a change goes: with a cloud, to the SSM parameter through
 * Manager, after which this machine's daemon reads it again; without one, to
 * the daemon, which keeps it in its own config. A machine with a cloud never
 * writes the daemon's copy, and never writes without a signed-in operator.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonRequest, makeDataDir, startStubServer, type StubServer } from "../helpers";

const changeDeploymentSettingsParameter = vi.fn();
const roleChain = vi.fn();

vi.mock("@starkeep/admin-installer/app-creds", () => ({
  changeDeploymentSettingsParameter: (...args: unknown[]) =>
    changeDeploymentSettingsParameter(...args),
}));
vi.mock("@starkeep/admin-installer/session", () => ({
  roleChain: (...args: unknown[]) => roleChain(...args),
}));

let daemon: StubServer;
let reply: { status: number; body: string } = { status: 200, body: "{}" };
let route: typeof import("../../src/routes/deployment-settings");
let configPath: string;

const CREDENTIALS = {
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  sessionToken: "token",
  expiration: "2026-10-17T12:00:00.000Z",
};

const CLOUD_CONFIG = {
  stackPrefix: "sktest",
  accountId: "123456789012",
  managerRoleArn: "arn:aws:iam::123456789012:role/sktest-manager-role",
  apiGatewayUrl: "https://abc.execute-api.us-east-2.amazonaws.com",
};

const put = (body: unknown) => route.PUT(jsonRequest("/api/deployment-settings", body, "PUT"));

beforeAll(async () => {
  const dir = makeDataDir("adminweb-deployment-settings-");
  configPath = join(dir, "config.json");
  process.env.STARKEEP_DIR = dir;
  daemon = await startStubServer(() => reply);
  vi.doMock("../../src/lib/runtime-config", () => ({
    localDataServerUrl: async () => daemon.url,
    getRuntimeConfig: async () => ({ localDataServerUrl: daemon.url, driveUrl: daemon.url }),
  }));
  route = await import("../../src/routes/deployment-settings");
});

afterAll(async () => {
  await daemon.stop();
});

beforeEach(() => {
  reply = { status: 200, body: "{}" };
  daemon.seen.length = 0;
  rmSync(configPath, { force: true });
  changeDeploymentSettingsParameter
    .mockReset()
    .mockImplementation(async (opts: { change: unknown }) => ({
      ok: true,
      settings: opts.change,
    }));
  roleChain.mockReset().mockResolvedValue({
    accessKeyId: "ASIA-MANAGER",
    secretAccessKey: "s",
    sessionToken: "t",
    expiration: new Date(),
  });
});

describe("reading", () => {
  it("reads this machine's view through the daemon", async () => {
    reply = { status: 200, body: JSON.stringify({ set: false, retentionDays: 30 }) };
    const res = await route.GET();
    expect(await res.json()).toEqual({ set: false, retentionDays: 30 });
    expect(daemon.seen.at(-1)).toMatchObject({
      method: "GET",
      url: "/library/deployment-settings",
    });
  });
});

describe("a machine with no cloud", () => {
  it("forwards the change to the daemon, and carries a refusal's status", async () => {
    reply = { status: 422, body: JSON.stringify({ problems: ["out of range"] }) };
    const change = { standIns: { image: { canonicalThreshold: 100 } } };
    const res = await put({ change });
    expect(res.status).toBe(422);
    const sent = daemon.seen.at(-1)!;
    expect(sent).toMatchObject({ method: "PUT", url: "/library/deployment-settings" });
    expect(JSON.parse(sent.body)).toEqual(change);
    expect(changeDeploymentSettingsParameter).not.toHaveBeenCalled();
  });
});

describe("a machine with a cloud", () => {
  beforeEach(() => {
    writeFileSync(configPath, JSON.stringify(CLOUD_CONFIG));
  });

  it("writes the parameter as Manager, then has the daemon read it again", async () => {
    const change = { trash: { retentionDays: 90 } };
    const res = await put({
      change,
      credentials: CREDENTIALS,
      stackPrefix: "sktest",
      region: "us-east-2",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, settings: change });

    const [chain, opts] = roleChain.mock.calls[0] as [string[], { sessionPrefix: string }];
    expect(chain).toEqual([CLOUD_CONFIG.managerRoleArn]);
    expect(opts.sessionPrefix).toBe("starkeep-deployment-settings");
    const [args] = changeDeploymentSettingsParameter.mock.calls[0] as [
      { stackPrefix: string; change: unknown; awsCreds: { accessKeyId: string } },
    ];
    expect(args).toMatchObject({ stackPrefix: "sktest", change });
    expect(args.awsCreds.accessKeyId).toBe("ASIA-MANAGER");

    expect(daemon.seen.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST /library/deployment-settings/refresh",
    ]);
  });

  it("refuses without a signed-in operator, and writes nothing anywhere", async () => {
    const res = await put({ change: { trash: { retentionDays: 90 } } });
    expect(res.status).toBe(401);
    expect(changeDeploymentSettingsParameter).not.toHaveBeenCalled();
    expect(daemon.seen).toEqual([]);
  });

  it("answers 422 with the problems when the result does not check out", async () => {
    changeDeploymentSettingsParameter.mockResolvedValue({ ok: false, problems: ["out of range"] });
    const res = await put({
      change: {},
      credentials: CREDENTIALS,
      stackPrefix: "sktest",
      region: "us-east-2",
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { problems: string[] }).problems).toEqual(["out of range"]);
    expect(daemon.seen).toEqual([]);
  });

  it("answers 500 naming the reason when Manager cannot be assumed", async () => {
    roleChain.mockRejectedValue(new Error("ExpiredToken"));
    const res = await put({
      change: {},
      credentials: CREDENTIALS,
      stackPrefix: "sktest",
      region: "us-east-2",
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("ExpiredToken");
  });
});
