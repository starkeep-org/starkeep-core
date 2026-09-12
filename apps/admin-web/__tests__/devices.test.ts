/**
 * POST and DELETE /api/devices — pairing and revoking a handset.
 *
 * Pairing is the one step that cannot be authenticated by the thing being
 * registered, so it happens here, in the privileged console, with credentials
 * the operator already holds. Three properties carry that:
 *
 *   - Both inputs are validated *here*, because a key that fails to parse in
 *     the Lambda is a device that silently cannot sync, diagnosable only from
 *     CloudWatch.
 *   - The privileged write runs as Manager, assumed from the operator's own
 *     session. The admin-app role deliberately holds no write on
 *     `app-creds/*`, so a route that skipped the hop would be denied.
 *   - The Manager role ARN comes off disk, never out of the request body. It is
 *     the one input that decides which identity does the write.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonRequest, makeDataDir, type RouteHandler } from "./helpers";

const putDeviceKeyParameter = vi.fn();
const deleteDeviceKeyParameter = vi.fn();
const roleChain = vi.fn();

vi.mock("@starkeep/admin-installer/app-creds", () => ({
  putDeviceKeyParameter: (...args: unknown[]) => putDeviceKeyParameter(...args),
  deleteDeviceKeyParameter: (...args: unknown[]) => deleteDeviceKeyParameter(...args),
}));
vi.mock("@starkeep/admin-installer/session", () => ({
  roleChain: (...args: unknown[]) => roleChain(...args),
}));

let POST: RouteHandler;
let DELETE: RouteHandler;
let dataDir: string;
let configPath: string;

/** 32-byte Ed25519 key in a 44-byte SPKI wrapper, base64 — always 60 chars. */
const SPKI = "M".repeat(59) + "=";

const CREDENTIALS = {
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  sessionToken: "token",
  expiration: "2026-09-12T12:00:00.000Z",
};

function pairBody(over: Record<string, unknown> = {}) {
  return {
    credentials: CREDENTIALS,
    stackPrefix: "sktest",
    region: "us-east-2",
    deviceId: "pixel-9",
    publicKeySpki: SPKI,
    ...over,
  };
}

beforeAll(async () => {
  dataDir = makeDataDir("adminweb-devices-");
  configPath = join(dataDir, "config.json");
  process.env.STARKEEP_DIR = dataDir;
  const route = await import("../app/api/devices/route");
  POST = route.POST as unknown as RouteHandler;
  DELETE = route.DELETE as unknown as RouteHandler;
});

beforeEach(() => {
  putDeviceKeyParameter.mockReset().mockResolvedValue("/sktest/app-creds/_device-pixel-9");
  deleteDeviceKeyParameter.mockReset().mockResolvedValue(undefined);
  roleChain.mockReset().mockResolvedValue({
    accessKeyId: "ASIA-MANAGER",
    secretAccessKey: "s",
    sessionToken: "t",
    expiration: new Date(),
  });
  rmSync(configPath, { force: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      stackPrefix: "sktest",
      accountId: "123456789012",
      managerRoleArn: "arn:aws:iam::123456789012:role/sktest-manager-role",
    }),
  );
});

const pair = (body: unknown) => POST(jsonRequest("/api/devices", body));
const revoke = (body: unknown) => DELETE(jsonRequest("/api/devices", body, "DELETE"));

describe("validating what becomes a parameter name", () => {
  it.each([
    ["an empty id", ""],
    ["a slash, which would address a different parameter", "pixel/9"],
    ["a space", "pixel 9"],
    ["an id over 128 characters", "a".repeat(129)],
  ])("refuses %s", async (_label, deviceId) => {
    const res = await pair(pairBody({ deviceId }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("deviceId");
    expect(putDeviceKeyParameter).not.toHaveBeenCalled();
  });

  it("accepts the characters a device id is allowed to carry", async () => {
    const res = await pair(pairBody({ deviceId: "Pixel_9-test123" }));
    expect(res.status).toBe(200);
  });
});

describe("validating the key", () => {
  it.each([
    ["an empty key", ""],
    ["a raw 32-byte key with no SPKI wrapper", "M".repeat(43) + "="],
    ["a key with a character base64 does not use", "!".repeat(59) + "="],
    ["a key missing its padding", "M".repeat(60)],
  ])("refuses %s at pairing time, not in the Lambda", async (_label, publicKeySpki) => {
    const res = await pair(pairBody({ publicKeySpki }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("publicKeySpki");
    expect(putDeviceKeyParameter).not.toHaveBeenCalled();
  });
});

describe("the privileged write", () => {
  it("stores the public key under the device's parameter and reports its name", async () => {
    const res = await pair(pairBody({ userId: "u-1", label: "Aaron's phone" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      paired: { deviceId: "pixel-9", parameterName: "/sktest/app-creds/_device-pixel-9" },
    });

    const [args] = putDeviceKeyParameter.mock.calls[0] as [Record<string, never>];
    expect(args).toMatchObject({ stackPrefix: "sktest", deviceId: "pixel-9", region: "us-east-2" });
    const registration = (args as unknown as { registration: Record<string, unknown> }).registration;
    expect(registration).toMatchObject({ publicKeySpki: SPKI, userId: "u-1", label: "Aaron's phone" });
    expect(typeof registration.pairedAt).toBe("string");
  });

  it("records a null userId rather than omitting the field", async () => {
    // Nothing reads it yet. It is what saves already-paired devices a migration
    // when shared data is finally partitioned per user.
    await pair(pairBody());
    const [args] = putDeviceKeyParameter.mock.calls[0] as [
      { registration: Record<string, unknown> },
    ];
    expect(args.registration).toMatchObject({ userId: null, label: null });
  });

  it("assumes Manager from the operator's session before writing", async () => {
    await pair(pairBody());
    expect(roleChain).toHaveBeenCalledTimes(1);
    const [chain, opts] = roleChain.mock.calls[0] as [string[], Record<string, unknown>];
    expect(chain).toEqual(["arn:aws:iam::123456789012:role/sktest-manager-role"]);
    expect(opts).toMatchObject({ region: "us-east-2", sessionPrefix: "starkeep-pair-device" });
    expect((opts.baseCredentials as { accessKeyId: string }).accessKeyId).toBe("AKIA");

    const [args] = putDeviceKeyParameter.mock.calls[0] as [{ awsCreds: { accessKeyId: string } }];
    expect(args.awsCreds.accessKeyId).toBe("ASIA-MANAGER");
  });

  it("takes the role ARN off disk, never out of the request body", async () => {
    // The ARN decides which identity does a privileged write. It is already on
    // disk; there is no reason for it to make a round trip through the browser.
    await pair(pairBody({ managerRoleArn: "arn:aws:iam::999:role/attacker" }));
    const [chain] = roleChain.mock.calls[0] as [string[]];
    expect(chain).toEqual(["arn:aws:iam::123456789012:role/sktest-manager-role"]);
  });

  it("derives the ARN for a config written before managerRoleArn was recorded", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ stackPrefix: "sktest", accountId: "123456789012" }),
    );
    await pair(pairBody());
    const [chain] = roleChain.mock.calls[0] as [string[]];
    expect(chain).toEqual(["arn:aws:iam::123456789012:role/sktest-manager-role"]);
  });

  it("answers 500 naming the reason when there is no cloud setup to assume into", async () => {
    rmSync(configPath, { force: true });
    const res = await pair(pairBody());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("config.json");
    expect(putDeviceKeyParameter).not.toHaveBeenCalled();
  });

  it("answers 500 when the config names no ARN and carries nothing to derive one from", async () => {
    writeFileSync(configPath, JSON.stringify({ stackPrefix: "sktest" }));
    const res = await pair(pairBody());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("managerRoleArn");
  });

  it("surfaces an SSM failure as 500 rather than reporting a pairing that did not happen", async () => {
    putDeviceKeyParameter.mockRejectedValue(new Error("AccessDeniedException"));
    const res = await pair(pairBody());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("AccessDeniedException");
  });
});

describe("revoking", () => {
  it("deletes the device's parameter through the same Manager hop", async () => {
    const res = await revoke(pairBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: "pixel-9" });
    expect(roleChain).toHaveBeenCalledTimes(1);
    const [args] = deleteDeviceKeyParameter.mock.calls[0] as [
      { stackPrefix: string; deviceId: string; awsCreds: { accessKeyId: string } },
    ];
    expect(args).toMatchObject({ stackPrefix: "sktest", deviceId: "pixel-9" });
    expect(args.awsCreds.accessKeyId).toBe("ASIA-MANAGER");
  });

  it("refuses a device id that would address something else", async () => {
    const res = await revoke(pairBody({ deviceId: "pixel/9" }));
    expect(res.status).toBe(400);
    expect(deleteDeviceKeyParameter).not.toHaveBeenCalled();
  });

  it("surfaces a delete failure as 500, so a revoke is never reported falsely", async () => {
    deleteDeviceKeyParameter.mockRejectedValue(new Error("ParameterNotFound"));
    const res = await revoke(pairBody());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("ParameterNotFound");
  });
});
