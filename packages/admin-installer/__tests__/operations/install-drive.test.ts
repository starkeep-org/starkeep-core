/** `installDriveOp`: it needs the cloud data server's outputs and the admin's credentials. */
import { describe, expect, it } from "vitest";
import { installDriveOp } from "../../src/operations/install-drive.js";
import { CREDS, INSTALLED_CONFIG, starkeepDirWith, testContext, withCode } from "./helpers.js";

describe("installDriveOp", () => {
  it("installs Drive with the deployment's coordinates and the admin's credentials", async () => {
    const seen: unknown[] = [];
    const t = testContext(starkeepDirWith(INSTALLED_CONFIG), {
      installDrive: async (config, creds) => void seen.push(config, creds),
    });
    await expect(installDriveOp(t.ctx, {}, t.emit)).resolves.toEqual({ installed: true });
    expect(seen[0]).toMatchObject({
      stackPrefix: "sktest",
      region: "us-east-1",
      accountId: "123456789012",
      dsqlHostname: INSTALLED_CONFIG.auroraEndpoint,
      filesBucket: "bucket",
      installDdlRoleArn: "arn:aws:iam::123456789012:role/sktest-install-ddl-role",
      artifactsBucket: "sktest-artifacts-123456789012-us-east-1",
    });
    expect(seen[1]).toEqual(CREDS);
  });

  it("reports CONFIG_INCOMPLETE before the cloud data server is installed", async () => {
    const { auroraEndpoint: _a, ...partial } = INSTALLED_CONFIG;
    const t = testContext(starkeepDirWith(partial), { installDrive: async () => {} });
    await expect(installDriveOp(t.ctx, {}, t.emit)).rejects.toEqual(withCode("CONFIG_INCOMPLETE"));
    expect(t.lanes).toEqual([]);
  });

  it("reports NOT_SIGNED_IN without a session", async () => {
    const t = testContext(
      starkeepDirWith(INSTALLED_CONFIG),
      { installDrive: async () => {} },
      { signedIn: false },
    );
    await expect(installDriveOp(t.ctx, {}, t.emit)).rejects.toEqual(withCode("NOT_SIGNED_IN"));
  });
});
