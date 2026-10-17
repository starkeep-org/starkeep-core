/**
 * POST /api/devices/list, POST and DELETE /api/devices — listing, pairing and
 * revoking a phone.
 *
 * Pairing is a phone's install step, so it happens here, in the privileged
 * console. These properties carry it:
 *
 *   - The inputs are validated *here*, because a key that fails to parse in the
 *     Lambda is a device that silently cannot sync, diagnosable only from
 *     CloudWatch.
 *   - Every SSM call runs as Manager, assumed from the operator's own session,
 *     with the role ARN off disk, never out of the request body.
 *   - The route, not the browser, decides the device's kind and the apps it
 *     may act as.
 *   - The list is the device records, so the list and what the broker accepts
 *     cannot disagree. A map stands in for SSM in these tests.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonRequest, makeDataDir } from "./helpers";

interface Device {
  deviceId: string;
  userId: string | null;
  kind: string;
  label: string | null;
  appIds: string[];
  pairedAt: string;
  publicKeySpki?: string;
}

/** The device records, as SSM would hold them. */
const records = new Map<string, Omit<Device, "deviceId">>();

const putDeviceKeyParameter = vi.fn();
const deleteDeviceKeyParameter = vi.fn();
const listDeviceRecords = vi.fn();
const roleChain = vi.fn();

vi.mock("@starkeep/admin-installer/app-creds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/admin-installer/app-creds")>();
  return {
    // The real code reader and fingerprint; only the SSM calls are faked.
    parsePairingRequest: actual.parsePairingRequest,
    deviceFingerprint: actual.deviceFingerprint,
    putDeviceKeyParameter: (...args: unknown[]) => putDeviceKeyParameter(...args),
    deleteDeviceKeyParameter: (...args: unknown[]) => deleteDeviceKeyParameter(...args),
    listDeviceRecords: (...args: unknown[]) => listDeviceRecords(...args),
  };
});
vi.mock("@starkeep/admin-installer/session", () => ({
  roleChain: (...args: unknown[]) => roleChain(...args),
}));

let LIST: (req: Request) => Promise<Response>;
let INSPECT: (req: Request) => Promise<Response>;
let APPROVE: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let DELETE: (req: Request) => Promise<Response>;
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

const CONFIG = {
  stackPrefix: "sktest",
  accountId: "123456789012",
  managerRoleArn: "arn:aws:iam::123456789012:role/sktest-manager-role",
  publicBaseUrl: "https://d123.cloudfront.net",
  apiGatewayUrl: "https://abc.execute-api.us-east-2.amazonaws.com",
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

const listBody = { credentials: CREDENTIALS, stackPrefix: "sktest", region: "us-east-2" };

/** The records as stored, by id. */
function stored(): Device[] {
  return [...records.entries()].map(([deviceId, r]) => ({ deviceId, ...r }));
}

beforeAll(async () => {
  dataDir = makeDataDir("adminweb-devices-");
  configPath = join(dataDir, "config.json");
  process.env.STARKEEP_DIR = dataDir;
  const route = await import("../src/routes/devices");
  LIST = route.LIST;
  INSPECT = route.INSPECT;
  APPROVE = route.APPROVE;
  POST = route.POST;
  DELETE = route.DELETE;
}, 60_000);

beforeEach(() => {
  records.clear();
  putDeviceKeyParameter.mockReset().mockImplementation(
    async (opts: { deviceId: string; registration: Omit<Device, "deviceId"> }) => {
      records.set(opts.deviceId, opts.registration);
      return `/sktest/platform/devices/${opts.deviceId}`;
    },
  );
  deleteDeviceKeyParameter.mockReset().mockImplementation(async (opts: { deviceId: string }) => {
    records.delete(opts.deviceId);
  });
  listDeviceRecords.mockReset().mockImplementation(async () => stored());
  roleChain.mockReset().mockResolvedValue({
    accessKeyId: "ASIA-MANAGER",
    secretAccessKey: "s",
    sessionToken: "t",
    expiration: new Date(),
  });
  rmSync(configPath, { force: true });
  writeFileSync(configPath, JSON.stringify(CONFIG));
});

const pair = (body: unknown) => POST(jsonRequest("/api/devices", body));
const revoke = (body: unknown) => DELETE(jsonRequest("/api/devices", body, "DELETE"));
const list = (body: unknown = listBody) => LIST(jsonRequest("/api/devices/list", body));

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
    expect(stored()).toEqual([]);
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

  it("refuses a label longer than 100 characters", async () => {
    const res = await pair(pairBody({ label: "x".repeat(101) }));
    expect(res.status).toBe(400);
    expect(putDeviceKeyParameter).not.toHaveBeenCalled();
  });

  it("trims the label, and records a blank one as null", async () => {
    await pair(pairBody({ label: "  Pixel 9  " }));
    expect(stored()[0]!.label).toBe("Pixel 9");
    await pair(pairBody({ deviceId: "blank", label: "   " }));
    expect(stored().find((d) => d.deviceId === "blank")!.label).toBeNull();
  });
});

describe("pairing", () => {
  it("stores the device's record, and answers the cloud URL for the QR code", async () => {
    const res = await pair(pairBody({ userId: "u-1", label: "Aaron's phone" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paired: unknown; baseUrl: string };
    expect(body.paired).toEqual({ deviceId: "pixel-9", parameterName: "/sktest/platform/devices/pixel-9" });
    expect(body.baseUrl).toBe("https://d123.cloudfront.net");

    const [args] = putDeviceKeyParameter.mock.calls[0] as [Record<string, never>];
    expect(args).toMatchObject({ stackPrefix: "sktest", deviceId: "pixel-9", region: "us-east-2" });
    expect(stored()).toEqual([
      {
        deviceId: "pixel-9",
        publicKeySpki: SPKI,
        userId: "u-1",
        kind: "phone",
        label: "Aaron's phone",
        appIds: ["starkeep-drive"],
        pairedAt: expect.any(String),
      },
    ]);
  });

  it("decides the device's apps itself, whatever the request says", async () => {
    await pair(pairBody({ appIds: ["photos", "memo"] }));
    expect(stored()[0]).toMatchObject({ kind: "phone", appIds: ["starkeep-drive"] });
  });

  it("records a desktop with no app list, because the cloud scopes a desktop to its installed apps", async () => {
    await pair(pairBody({ kind: "desktop", appIds: ["photos"] }));
    expect(stored()[0]).toMatchObject({ kind: "desktop", appIds: [] });
  });

  it("records anything that is not a desktop as a phone", async () => {
    await pair(pairBody({ kind: "server" }));
    expect(stored()[0]).toMatchObject({ kind: "phone", appIds: ["starkeep-drive"] });
  });

  it("answers 500 naming the reason when the record write fails", async () => {
    putDeviceKeyParameter.mockRejectedValue(new Error("AccessDeniedException"));
    const res = await pair(pairBody());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("AccessDeniedException");
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
  });

  it("answers 500, writing nothing, when Manager cannot be assumed", async () => {
    roleChain.mockRejectedValue(new Error("ExpiredToken"));
    const res = await pair(pairBody());
    expect(res.status).toBe(500);
    expect(putDeviceKeyParameter).not.toHaveBeenCalled();
  });

  it("answers 500 when the config names no ARN and carries nothing to derive one from", async () => {
    writeFileSync(configPath, JSON.stringify({ stackPrefix: "sktest", publicBaseUrl: CONFIG.publicBaseUrl }));
    const res = await pair(pairBody());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("managerRoleArn");
  });
});

describe("listing", () => {
  it("lists the device records through the same Manager hop, without their keys", async () => {
    await pair(pairBody({ label: "Pixel 9", userId: "u-1" }));
    const res = await list();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: Device[] };
    expect(body.devices).toEqual([
      expect.objectContaining({ deviceId: "pixel-9", label: "Pixel 9", kind: "phone", userId: "u-1" }),
    ]);
    expect(body.devices[0]).not.toHaveProperty("publicKeySpki");
    const [args] = listDeviceRecords.mock.calls[0] as [{ awsCreds: { accessKeyId: string } }];
    expect(args.awsCreds.accessKeyId).toBe("ASIA-MANAGER");
  });

  it("answers 500 rather than an empty list when SSM cannot be read", async () => {
    listDeviceRecords.mockRejectedValue(new Error("AccessDeniedException"));
    const res = await list();
    expect(res.status).toBe(500);
  });
});

describe("revoking", () => {
  it("deletes the record through the same Manager hop", async () => {
    await pair(pairBody());
    const res = await revoke(pairBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: "pixel-9" });
    expect(stored()).toEqual([]);

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

  it("answers 500 when the delete fails, and the device stays listed", async () => {
    await pair(pairBody());
    deleteDeviceKeyParameter.mockRejectedValue(new Error("AccessDeniedException"));
    const res = await revoke(pairBody());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("AccessDeniedException");
    expect(stored().map((d) => d.deviceId)).toEqual(["pixel-9"]);
  });
});

describe("approving a device from its pairing code", () => {
  const code = (over: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({ v: 1, deviceId: "dev_member", publicKeySpki: SPKI, label: "Sam's laptop", kind: "desktop", ...over }),
    ).toString("base64url");
  const approve = (body: unknown) => APPROVE(jsonRequest("/api/devices/approve", body));

  it("shows what the code says and its fingerprint, touching nothing", async () => {
    const res = await INSPECT(jsonRequest("/api/devices/inspect", { code: code() }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { request: unknown; fingerprint: string };
    expect(body.request).toEqual({ deviceId: "dev_member", publicKeySpki: SPKI, label: "Sam's laptop", kind: "desktop" });
    expect(body.fingerprint).toMatch(/^[0-9a-f]{4} [0-9a-f]{4}$/);
    expect(roleChain).not.toHaveBeenCalled();
  });

  it("refuses a code that does not parse, naming why", async () => {
    const res = await INSPECT(jsonRequest("/api/devices/inspect", { code: "not a code" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not a Starkeep pairing code/);
  });

  it("records the device as the code describes it, for the user the admin names, as Manager", async () => {
    const res = await approve({ code: code(), credentials: CREDENTIALS, stackPrefix: "sktest", region: "us-east-2", userId: "sub-admin" });
    expect(res.status).toBe(200);
    expect(stored()).toEqual([
      {
        deviceId: "dev_member",
        publicKeySpki: SPKI,
        userId: "sub-admin",
        kind: "desktop",
        label: "Sam's laptop",
        appIds: [],
        pairedAt: expect.any(String),
      },
    ]);
    const [args] = putDeviceKeyParameter.mock.calls[0] as [{ awsCreds: { accessKeyId: string } }];
    expect(args.awsCreds.accessKeyId).toBe("ASIA-MANAGER");
  });

  it("gives a phone approved by code the phone's apps", async () => {
    await approve({ code: code({ kind: "phone" }), credentials: CREDENTIALS, stackPrefix: "sktest", region: "us-east-2" });
    expect(stored()[0]).toMatchObject({ kind: "phone", appIds: ["starkeep-drive"] });
  });

  it("refuses without a signed-in operator, and writes nothing", async () => {
    const res = await approve({ code: code() });
    expect(res.status).toBe(401);
    expect(putDeviceKeyParameter).not.toHaveBeenCalled();
  });
});
