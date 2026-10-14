/**
 * GET, POST and DELETE /api/devices — listing, pairing and revoking a phone.
 *
 * Pairing is a phone's install step, so it happens here, in the privileged
 * console. These properties carry it:
 *
 *   - The inputs are validated *here*, because a key that fails to parse in the
 *     Lambda is a device that silently cannot sync, diagnosable only from
 *     CloudWatch.
 *   - The privileged write runs as Manager, assumed from the operator's own
 *     session, with the role ARN off disk, never out of the request body.
 *   - The route, not the browser, decides which apps the device may act as.
 *   - The list entry goes into the library's settings file *before* the key,
 *     and comes out *after* it, so the list never misses a device that can
 *     sync. A real local data server holds the list in these tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getFreePort, startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { jsonRequest, makeDataDir } from "./helpers";

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

let GET: () => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let DELETE: (req: Request) => Promise<Response>;
let dataDir: string;
let configPath: string;
let lds: LocalDataServer;

/** 32-byte Ed25519 key in a 44-byte SPKI wrapper, base64 — always 60 chars. */
const SPKI = "M".repeat(59) + "=";

const CREDENTIALS = {
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  sessionToken: "token",
  expiration: "2026-09-12T12:00:00.000Z",
};

const CONFIG = {
  stackPrefix: "sktest",
  accountId: "123456789012",
  managerRoleArn: "arn:aws:iam::123456789012:role/sktest-manager-role",
  publicBaseUrl: "https://d123.cloudfront.net",
  apiGatewayUrl: "https://abc.execute-api.us-east-2.amazonaws.com",
};

interface Device {
  deviceId: string;
  label: string | null;
  appIds: string[];
  pairedAt: string;
}

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

/** The list as the local data server holds it, read around the route. */
async function listed(): Promise<Device[]> {
  const res = await fetch(`${lds.url}/library/paired-devices`);
  return ((await res.json()) as { devices: Device[] }).devices;
}

/** Run `fn` with the route pointed at a port where nothing listens. */
async function withDaemonDown<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.STARKEEP_LOCAL_DATA_SERVER_URL;
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL = `http://127.0.0.1:${await getFreePort()}`;
  try {
    return await fn();
  } finally {
    process.env.STARKEEP_LOCAL_DATA_SERVER_URL = saved;
  }
}

beforeAll(async () => {
  lds = await startLocalDataServer();
  dataDir = makeDataDir("adminweb-devices-");
  configPath = join(dataDir, "config.json");
  process.env.STARKEEP_DIR = dataDir;
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL = lds.url;
  const route = await import("../src/routes/devices");
  GET = route.GET;
  POST = route.POST;
  DELETE = route.DELETE;
}, 60_000);

afterAll(async () => {
  await lds?.stop();
});

beforeEach(async () => {
  putDeviceKeyParameter.mockReset().mockResolvedValue("/sktest/app-creds/_device-pixel-9");
  deleteDeviceKeyParameter.mockReset().mockResolvedValue(undefined);
  roleChain.mockReset().mockResolvedValue({
    accessKeyId: "ASIA-MANAGER",
    secretAccessKey: "s",
    sessionToken: "t",
    expiration: new Date(),
  });
  rmSync(configPath, { force: true });
  writeFileSync(configPath, JSON.stringify(CONFIG));
  // Empty the list between tests, through the daemon, so each starts clean.
  for (const device of await listed()) {
    await fetch(`${lds.url}/library/paired-devices/${device.deviceId}`, { method: "DELETE" });
  }
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
    expect(await listed()).toEqual([]);
  });

  it("accepts the characters a device id is allowed to carry", async () => {
    const res = await pair(pairBody({ deviceId: "Pixel_9-test123" }));
    expect(res.status).toBe(200);
  });
});

describe("validating the key and the label", () => {
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

  it("refuses a label longer than the settings file allows", async () => {
    const res = await pair(pairBody({ label: "x".repeat(101) }));
    expect(res.status).toBe(400);
    expect(putDeviceKeyParameter).not.toHaveBeenCalled();
  });

  it("trims the label, and records a blank one as null", async () => {
    await pair(pairBody({ label: "  Pixel 9  " }));
    expect((await listed())[0]!.label).toBe("Pixel 9");
    await pair(pairBody({ deviceId: "blank", label: "   " }));
    expect((await listed()).find((d) => d.deviceId === "blank")!.label).toBeNull();
  });
});

describe("pairing", () => {
  it("lists the device and stores its key, and answers the cloud URL for the QR code", async () => {
    const res = await pair(pairBody({ userId: "u-1", label: "Aaron's phone" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paired: unknown; baseUrl: string; devices: Device[] };
    expect(body.paired).toEqual({ deviceId: "pixel-9", parameterName: "/sktest/app-creds/_device-pixel-9" });
    expect(body.baseUrl).toBe("https://d123.cloudfront.net");
    expect(body.devices.map((d) => d.deviceId)).toEqual(["pixel-9"]);

    const [args] = putDeviceKeyParameter.mock.calls[0] as [Record<string, never>];
    expect(args).toMatchObject({ stackPrefix: "sktest", deviceId: "pixel-9", region: "us-east-2" });
    const registration = (args as unknown as { registration: Record<string, unknown> }).registration;
    expect(registration).toMatchObject({
      publicKeySpki: SPKI,
      userId: "u-1",
      label: "Aaron's phone",
      appIds: ["starkeep-drive"],
    });

    const [entry] = await listed();
    expect(entry).toMatchObject({ deviceId: "pixel-9", label: "Aaron's phone", appIds: ["starkeep-drive"] });
    // One pairing, one timestamp: the list and the key agree on when.
    expect(entry!.pairedAt).toBe(registration.pairedAt);
  });

  it("decides the device's apps itself, whatever the request says", async () => {
    await pair(pairBody({ appIds: ["photos", "memo"] }));
    const [args] = putDeviceKeyParameter.mock.calls[0] as [{ registration: { appIds: string[] } }];
    expect(args.registration.appIds).toEqual(["starkeep-drive"]);
    expect((await listed())[0]!.appIds).toEqual(["starkeep-drive"]);
  });

  it("lists the device before it writes the key", async () => {
    // A key without an entry is a phone that syncs and that nobody can find to
    // revoke. So the entry must already be there when the key is written.
    let listedAtKeyWrite: Device[] = [];
    putDeviceKeyParameter.mockImplementation(async () => {
      listedAtKeyWrite = await listed();
      return "/sktest/app-creds/_device-pixel-9";
    });
    await pair(pairBody());
    expect(listedAtKeyWrite.map((d) => d.deviceId)).toEqual(["pixel-9"]);
  });

  it("takes the entry back when the key write fails", async () => {
    putDeviceKeyParameter.mockRejectedValue(new Error("AccessDeniedException"));
    const res = await pair(pairBody());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("AccessDeniedException");
    expect(await listed()).toEqual([]);
  });

  it("refuses, writing nothing, when the local data server is down", async () => {
    const res = await withDaemonDown(() => pair(pairBody()));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/local data server is not running/);
    expect(putDeviceKeyParameter).not.toHaveBeenCalled();
  });

  it("falls back to the gateway URL for a config with no CloudFront distribution", async () => {
    const { publicBaseUrl: _drop, ...noCloudFront } = CONFIG;
    writeFileSync(configPath, JSON.stringify(noCloudFront));
    const res = await pair(pairBody());
    expect(((await res.json()) as { baseUrl: string }).baseUrl).toBe(CONFIG.apiGatewayUrl);
  });

  it("refuses, writing nothing, when no cloud has been deployed", async () => {
    const { publicBaseUrl: _a, apiGatewayUrl: _b, ...noCloud } = CONFIG;
    writeFileSync(configPath, JSON.stringify(noCloud));
    const res = await pair(pairBody());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no cloud URL/);
    expect(putDeviceKeyParameter).not.toHaveBeenCalled();
    expect(await listed()).toEqual([]);
  });
});

describe("the Manager hop", () => {
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
    await pair(pairBody({ managerRoleArn: "arn:aws:iam::999:role/attacker" }));
    const [chain] = roleChain.mock.calls[0] as [string[]];
    expect(chain).toEqual(["arn:aws:iam::123456789012:role/sktest-manager-role"]);
  });

  it("derives the ARN for a config written before managerRoleArn was recorded", async () => {
    const { managerRoleArn: _drop, ...older } = CONFIG;
    writeFileSync(configPath, JSON.stringify(older));
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
    expect(await listed()).toEqual([]);
  });

  it("answers 500, listing nothing, when Manager cannot be assumed", async () => {
    roleChain.mockRejectedValue(new Error("ExpiredToken"));
    const res = await pair(pairBody());
    expect(res.status).toBe(500);
    expect(await listed()).toEqual([]);
  });

  it("answers 500 when the config names no ARN and carries nothing to derive one from", async () => {
    writeFileSync(configPath, JSON.stringify({ stackPrefix: "sktest", publicBaseUrl: CONFIG.publicBaseUrl }));
    const res = await pair(pairBody());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("managerRoleArn");
  });
});

describe("listing", () => {
  it("reads the list through the local data server", async () => {
    await pair(pairBody({ label: "Pixel 9" }));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: Device[] };
    expect(body.devices.map((d) => [d.deviceId, d.label])).toEqual([["pixel-9", "Pixel 9"]]);
  });

  it("says the daemon is down rather than showing an empty list", async () => {
    const res = await withDaemonDown(() => GET());
    expect(res.status).toBe(503);
  });
});

describe("revoking", () => {
  it("deletes the key through the same Manager hop, then the entry", async () => {
    await pair(pairBody());
    let listedAtKeyDelete: Device[] = [];
    deleteDeviceKeyParameter.mockImplementation(async () => {
      listedAtKeyDelete = await listed();
    });

    const res = await revoke(pairBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: "pixel-9", devices: [] });
    // The entry outlived the key, so a failure between the two could only have
    // left a harmless entry.
    expect(listedAtKeyDelete.map((d) => d.deviceId)).toEqual(["pixel-9"]);
    expect(await listed()).toEqual([]);

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

  it("keeps the entry when the key delete fails, so the device can still be found", async () => {
    await pair(pairBody());
    deleteDeviceKeyParameter.mockRejectedValue(new Error("AccessDeniedException"));
    const res = await revoke(pairBody());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("AccessDeniedException");
    expect((await listed()).map((d) => d.deviceId)).toEqual(["pixel-9"]);
  });

  it("reports the revoke but names the list problem when the daemon is down", async () => {
    // The key is what lets a device sync, so a deleted key is a revoked device
    // whatever happens to the list afterwards.
    await pair(pairBody());
    const res = await withDaemonDown(() => revoke(pairBody()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: string; listError: string };
    expect(body.revoked).toBe("pixel-9");
    expect(body.listError).toMatch(/local data server is not running/);
  });
});
