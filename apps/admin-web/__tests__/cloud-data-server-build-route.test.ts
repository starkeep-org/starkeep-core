/**
 * POST /api/cloud-data-server/build — whether the cloud runs this checkout's
 * build. The record sits behind Manager, so the route needs the operator's
 * session, hops to Manager, and compares what it reads with this checkout's
 * last build.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { jsonRequest, makeDataDir, writeAdminConfig } from "./helpers";

const managerCredentials = vi.fn();
vi.mock("../src/lib/manager-credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/manager-credentials")>()),
  managerCredentials,
}));

const getCloudDataServerBuildParameter = vi.fn();
const readLocalCloudDataServerBuild = vi.fn();
vi.mock("@starkeep/admin-installer/cloud-data-server-build", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@starkeep/admin-installer/cloud-data-server-build")>()),
  getCloudDataServerBuildParameter,
  readLocalCloudDataServerBuild,
}));

const CREDENTIALS = { accessKeyId: "a", secretAccessKey: "s", sessionToken: "t", expiration: "" };
const SESSION = { credentials: CREDENTIALS, stackPrefix: "sk", region: "us-east-2" };
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const build = { bundleSha256: "a".repeat(64), commit: head, dirty: false };

let POST: (req: Request) => Promise<Response>;

beforeAll(async () => {
  const dataDir = makeDataDir();
  process.env.STARKEEP_DIR = dataDir;
  writeAdminConfig(dataDir, { stackPrefix: "sk", accountId: "111122223333" });
  POST = (await import("../src/routes/cloud-data-server-build")).POST;
});

beforeEach(() => {
  managerCredentials.mockReset().mockResolvedValue({ accessKeyId: "manager" });
  getCloudDataServerBuildParameter.mockReset();
  readLocalCloudDataServerBuild.mockReset().mockReturnValue(build);
});

const call = (body: unknown) => POST(jsonRequest("/api/cloud-data-server/build", body));

describe("POST /api/cloud-data-server/build", () => {
  it("asks for a sign-in when the body carries no session, and reads nothing", async () => {
    const res = await call({});
    expect(res.status).toBe(401);
    expect(managerCredentials).not.toHaveBeenCalled();
  });

  it("reads the record as Manager and reports a match", async () => {
    getCloudDataServerBuildParameter.mockResolvedValue(build);
    const res = await call(SESSION);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ comparison: "match", cloud: build, local: build, head });
    expect(getCloudDataServerBuildParameter).toHaveBeenCalledWith({
      stackPrefix: "sk",
      region: "us-east-2",
      awsCreds: { accessKeyId: "manager" },
    });
  });

  it("reports other code in the cloud", async () => {
    getCloudDataServerBuildParameter.mockResolvedValue({ ...build, bundleSha256: "b".repeat(64) });
    const body = (await (await call(SESSION)).json()) as { comparison: string };
    expect(body.comparison).toBe("differs");
  });

  it("reports a deployment with no record", async () => {
    getCloudDataServerBuildParameter.mockResolvedValue(null);
    const body = (await (await call(SESSION)).json()) as { comparison: string; cloud: unknown };
    expect(body).toMatchObject({ comparison: "not-recorded", cloud: null });
  });

  it("answers 500 with the message when the Manager hop fails", async () => {
    managerCredentials.mockRejectedValue(new Error("AccessDenied"));
    const res = await call(SESSION);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("AccessDenied");
  });
});
