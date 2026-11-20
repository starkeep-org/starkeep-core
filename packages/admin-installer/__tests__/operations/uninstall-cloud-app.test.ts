/** `uninstallCloudAppOp`: the manifest it tears down and the surfaces it removes. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appManifestSchema } from "@starkeep/admin-manifest";
import { uninstallCloudAppOp } from "../../src/operations/uninstall-cloud-app.js";
import type { UninstallInput } from "../../src/orchestrator.js";
import { INSTALLED_CONFIG, exampleApp, starkeepDirWith, testContext, withCode } from "./helpers.js";

function setup(stored: boolean) {
  const appDir = exampleApp();
  const manifest = appManifestSchema.parse(
    JSON.parse(readFileSync(join(appDir, "starkeep.manifest.json"), "utf8")),
  );
  const uninstalls: UninstallInput[] = [];
  let closed = 0;
  const t = testContext(starkeepDirWith(INSTALLED_CONFIG), {
    createDsqlRegistry: (() => ({
      storedManifest: async () => (stored ? manifest : null),
      close: async () => void closed++,
    })) as never,
    uninstallApp: async (input) => void uninstalls.push(input),
  });
  return { appDir, uninstalls, t, closed: () => closed };
}

describe("uninstallCloudAppOp", () => {
  it("removes the whole app with the manifest the registry stored", async () => {
    const { uninstalls, t, closed } = setup(true);
    await expect(uninstallCloudAppOp(t.ctx, { appId: "example-app" }, t.emit)).resolves.toEqual({
      appId: "example-app",
      surfaces: "all",
    });
    expect(uninstalls[0]!.surfaces).toBeUndefined();
    expect(uninstalls[0]!.manifest.id).toBe("example-app");
    expect(closed()).toBe(1);
    expect(t.progress()).toContain("Its data stays in the cloud");
  });

  it("removes only the named surface and keeps the data side", async () => {
    const { uninstalls, t } = setup(true);
    await uninstallCloudAppOp(t.ctx, { appId: "example-app", surfaces: ["web"] }, t.emit);
    expect(uninstalls[0]!.surfaces).toEqual(["web"]);
    expect(t.progress()).toContain("web app removed; its data stays installed");
  });

  it("falls back to the app's folder for a registry row without a stored manifest", async () => {
    const { appDir, uninstalls, t } = setup(false);
    await uninstallCloudAppOp(t.ctx, { appId: "example-app", appDir }, t.emit);
    expect(uninstalls).toHaveLength(1);
    expect(t.progress()).toContain("using its source folder");
  });

  it("reports MANIFEST_INVALID when neither the registry nor a folder holds the manifest", async () => {
    const { uninstalls, t, closed } = setup(false);
    await expect(uninstallCloudAppOp(t.ctx, { appId: "nowhere" }, t.emit)).rejects.toEqual(
      withCode("MANIFEST_INVALID"),
    );
    expect(uninstalls).toEqual([]);
    expect(closed()).toBe(1);
  });

  it("reports INVALID_INPUT for an unknown surface and CONFIG_INCOMPLETE without a cloud", async () => {
    const { t } = setup(true);
    await expect(
      uninstallCloudAppOp(t.ctx, { appId: "example-app", surfaces: ["tv" as never] }, t.emit),
    ).rejects.toEqual(withCode("INVALID_INPUT"));
    const bare = testContext(starkeepDirWith({ stackPrefix: "x", userPoolId: "us-east-1_a" }));
    await expect(
      uninstallCloudAppOp(bare.ctx, { appId: "example-app" }, bare.emit),
    ).rejects.toEqual(withCode("CONFIG_INCOMPLETE"));
  });
});
