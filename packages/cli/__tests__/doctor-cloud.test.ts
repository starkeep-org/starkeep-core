/**
 * `starkeep doctor`'s cloud checks, with stand-ins for the admin session, the
 * terminal's AWS credentials, the bootstrap stack and the cloud read.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "cli-doctor-cloud-"));
process.env.STARKEEP_DIR = dir;

const world = vi.hoisted(() => ({
  signedIn: true,
  account: "123456789012" as string | null,
  bootstrapChanges: 3 as number | "no-changes",
  reads: [] as Array<Record<string, unknown>>,
}));

vi.mock("@starkeep/operator/admin-session", async (original) => ({
  ...(await original<typeof import("@starkeep/operator/admin-session")>()),
  adminSessionStatus: () =>
    world.signedIn ? { signedIn: true, email: "admin@example.com" } : { signedIn: false },
}));
vi.mock("@starkeep/operator/bootstrap", async (original) => ({
  ...(await original<typeof import("@starkeep/operator/bootstrap")>()),
  callerIdentity: async () => {
    if (!world.account) throw new Error("no credentials");
    return { account: world.account, arn: "arn:aws:iam::123456789012:user/me" };
  },
}));
vi.mock("../src/cloud", async (original) => ({
  ...(await original<typeof import("../src/cloud")>()),
  cloudInstalled: () => true,
}));
vi.mock("../src/commands/cloud", async (original) => ({
  ...(await original<typeof import("../src/commands/cloud")>()),
  bootstrapState: async () => ({ kind: "read", changes: world.bootstrapChanges }),
  readCloudState: async (_io: unknown, options: Record<string, unknown>) => {
    world.reads.push(options);
    return {
      platform: {
        kind: "behind",
        record: { commit: "abc12345", branch: "main", dirty: false },
        cloudLacks: [{ commit: "def", subject: "s" }],
      },
      drive: true,
      apps: [],
    };
  },
}));

const { cloudChecks } = await import("../src/commands/doctor");
const { createIo } = await import("../src/io");

const io = () =>
  createIo({ json: false, cwd: dir, interactive: false, stdout: () => {}, stderr: () => {} });

beforeEach(() => {
  world.signedIn = true;
  world.account = "123456789012";
  world.bootstrapChanges = 3;
  world.reads = [];
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ userPoolId: "us-east-2_abc", accountId: "123456789012", stackPrefix: "sk" }),
  );
});

describe("the doctor's cloud checks", () => {
  it("warns about the bootstrap stack and a cloud data server behind the checkout, with each fix (CLI-029)", async () => {
    const results = await cloudChecks(io());
    expect(results.find((r) => r.name === "Bootstrap stack")).toMatchObject({
      level: "warn",
      fix: "starkeep cloud bootstrap-update",
    });
    expect(results.find((r) => r.name === "Cloud data server")).toMatchObject({
      level: "warn",
      fix: "starkeep update --platform",
    });
  });

  it("reads the cloud without a sign-in and without counting as a use of the session (CLI-029)", async () => {
    await cloudChecks(io());
    expect(world.reads).toEqual([{ signIn: false, markUsed: false }]);
  });

  it("without an admin session, says which checks it skips and still checks the AWS credentials and the bootstrap stack (CLI-029)", async () => {
    world.signedIn = false;
    const results = await cloudChecks(io());
    expect(results.find((r) => r.name === "Admin session")).toMatchObject({
      level: "warn",
      detail: "not signed in, so the cloud data server and Drive checks are skipped",
      fix: "starkeep login --admin",
    });
    expect(results.map((r) => r.name)).toEqual([
      "Admin session",
      "AWS credentials",
      "Bootstrap stack",
    ]);
    expect(world.reads).toEqual([]);
  });

  it("says only the bootstrap stack needs AWS credentials when the terminal has none", async () => {
    world.account = null;
    const results = await cloudChecks(io());
    expect(results.find((r) => r.name === "AWS credentials")).toMatchObject({
      level: "warn",
      detail: "this terminal has no AWS credentials; only the bootstrap stack needs them",
    });
  });
});
