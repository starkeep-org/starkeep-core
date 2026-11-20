/** `uninstallCloudDataServerOp`: Drive first, then the stack, and only when confirmed. */
import { describe, expect, it } from "vitest";
import { uninstallCloudDataServerOp } from "../../src/operations/uninstall-cloud-data-server.js";
import {
  INSTALLED_CONFIG,
  readConfigIn,
  starkeepDirWith,
  testContext,
  withCode,
} from "./helpers.js";

function setup(config: Record<string, unknown>, driveFails = false) {
  const calls: string[] = [];
  const dir = starkeepDirWith(config);
  const t = testContext(dir, {
    uninstallDrive: async () => {
      calls.push("drive");
      if (driveFails) throw new Error("role busy");
    },
    uninstallCloudDataServer: async () => void calls.push("cds"),
  });
  return { dir, calls, t };
}

describe("uninstallCloudDataServerOp", () => {
  it("uninstalls Drive, then the cloud data server, and clears the domain fields", async () => {
    const { dir, calls, t } = setup({
      ...INSTALLED_CONFIG,
      customDomain: "a.example.com",
      cloudfrontDomain: "d1.cloudfront.net",
    });
    await expect(uninstallCloudDataServerOp(t.ctx, { confirm: true }, t.emit)).resolves.toEqual({
      uninstalled: true,
      driveUninstalled: true,
    });
    expect(calls).toEqual(["drive", "cds"]);
    const after = readConfigIn(dir);
    expect(after.customDomain).toBeUndefined();
    expect(after.cloudfrontDomain).toBeUndefined();
    expect(after.stackPrefix).toBe("sktest");
  });

  it("goes on when Drive's uninstall fails, with a warning", async () => {
    const { calls, t } = setup(INSTALLED_CONFIG, true);
    const result = await uninstallCloudDataServerOp(t.ctx, { confirm: true }, t.emit);
    expect(result.driveUninstalled).toBe(false);
    expect(calls).toEqual(["drive", "cds"]);
    expect(t.progress()).toContain("Warning: the Starkeep Drive uninstall failed: role busy");
  });

  it("skips Drive for a config without install outputs", async () => {
    const { calls, t } = setup({
      stackPrefix: "sktest",
      userPoolId: "us-east-1_a",
      accountId: "1",
    });
    await uninstallCloudDataServerOp(t.ctx, { confirm: true }, t.emit);
    expect(calls).toEqual(["cds"]);
  });

  it("reports NOT_CONFIRMED without confirm, and touches nothing", async () => {
    const { calls, t } = setup(INSTALLED_CONFIG);
    await expect(uninstallCloudDataServerOp(t.ctx, {}, t.emit)).rejects.toEqual(
      withCode("NOT_CONFIRMED"),
    );
    expect(calls).toEqual([]);
    expect(t.lanes).toEqual([]);
  });
});
