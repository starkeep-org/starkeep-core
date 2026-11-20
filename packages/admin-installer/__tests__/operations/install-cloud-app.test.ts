/**
 * `installCloudAppOp`: every refusal it makes before it deploys, then the
 * deploy, the bundle it builds and the probe it runs afterwards.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@starkeep/protocol-primitives";
import { validateManifest } from "@starkeep/admin-manifest";
import { join } from "node:path";
import { installCloudAppOp } from "../../src/operations/install-cloud-app.js";
import { manifestDigest } from "../../src/manifest-approval.js";
import type { InstallInput } from "../../src/orchestrator.js";
import type { ProbeReport } from "../../src/post-install-probe.js";
import {
  CREDS,
  INSTALLED_CONFIG,
  exampleApp,
  starkeepDirWith,
  testContext,
  withCode,
} from "./helpers.js";

const APPROVED_BUNDLE = { command: "pnpm", args: ["run", "bundle"] };

const healthy = (version: string | null = PROTOCOL_VERSION) =>
  (async () =>
    new Response(
      JSON.stringify({ status: "ok", ...(version ? { protocolVersion: version } : {}) }),
      {
        headers: { "content-type": "application/json" },
      },
    )) as unknown as typeof fetch;

const QUIET_PROBE: ProbeReport = {
  exposed: false,
  dataPaths: [],
  publicPaths: [],
  trailingSlashPaths: [],
  unreachablePublicPaths: [],
  coldStart: null,
};

function setup(
  options: {
    manifest?: Record<string, unknown>;
    bundleExit?: number;
    probe?: ProbeReport;
    version?: string | null;
  } = {},
) {
  const appDir = exampleApp({ bundle: APPROVED_BUNDLE, ...options.manifest });
  const installs: InstallInput[] = [];
  const commands: string[] = [];
  const t = testContext(starkeepDirWith(INSTALLED_CONFIG), {
    fetch: healthy(options.version === undefined ? PROTOCOL_VERSION : options.version),
    runCommand: async (spec) => {
      commands.push(`${spec.command} ${spec.args.join(" ")}`);
      const out = spec.env?.STARKEEP_BUNDLE_OUT;
      if (out && (options.bundleExit ?? 0) === 0) writeFileSync(out, "zip bytes");
      return out ? (options.bundleExit ?? 0) : 0;
    },
    installApp: async (input) => {
      installs.push(input);
      return { appRoleArn: "arn:role", receipt: null };
    },
    probeAnonymousSurface: async () => options.probe ?? QUIET_PROBE,
  });
  return { appDir, installs, commands, t };
}

describe("installCloudAppOp", () => {
  it("builds the bundle, installs the web app, and names its address", async () => {
    const { appDir, installs, commands, t } = setup();
    const result = await installCloudAppOp(
      t.ctx,
      { appId: "example-app", appDir, surfaces: ["web"] },
      t.emit,
    );
    expect(result).toEqual({
      appId: "example-app",
      surfaces: ["web"],
      url: "https://d123.cloudfront.net/apps/example-app",
    });
    expect(commands.at(-1)).toBe("pnpm run bundle");
    expect(installs).toHaveLength(1);
    expect(installs[0]!.zipBuffer?.toString()).toBe("zip bytes");
    expect(installs[0]!.surfaces).toEqual(["web"]);
    expect(installs[0]!.registryCredentials).toEqual(CREDS);
    expect(installs[0]!.webSourceDir).toBe(appDir);
  });

  it("installs the data side alone with no bundle when asked for no surface", async () => {
    const { appDir, installs, commands, t } = setup();
    await installCloudAppOp(t.ctx, { appId: "example-app", appDir, surfaces: [] }, t.emit);
    expect(commands).toEqual([]);
    expect(installs[0]!.zipBuffer).toBeUndefined();
    expect(t.progress()).toContain("example-app is installed.");
  });

  it("reports MANIFEST_NOT_APPROVED for a folder that changed after approval, before signing in", async () => {
    const { appDir, installs, t } = setup();
    await expect(
      installCloudAppOp(
        t.ctx,
        { appId: "example-app", appDir, manifestDigest: "0".repeat(64) },
        t.emit,
      ),
    ).rejects.toEqual(withCode("MANIFEST_NOT_APPROVED"));
    expect(installs).toEqual([]);
    expect(t.lanes).toEqual([]);
  });

  it("goes on when the folder still holds the approved manifest", async () => {
    const { appDir, installs, t } = setup();
    const manifest = validateManifest(
      JSON.parse(readFileSync(join(appDir, "starkeep.manifest.json"), "utf8")),
    ).manifest!;
    await installCloudAppOp(
      t.ctx,
      { appId: "example-app", appDir, manifestDigest: manifestDigest(manifest) },
      t.emit,
    );
    expect(installs).toHaveLength(1);
  });

  it("reports COMMAND_NOT_APPROVED for a bundle command off the approved list", async () => {
    const { appDir, installs, t } = setup({
      manifest: { bundle: { command: "node", args: ["x.mjs"] } },
    });
    const err = await installCloudAppOp(t.ctx, { appId: "example-app", appDir }, t.emit).catch(
      (e) => e,
    );
    expect(err).toEqual(withCode("COMMAND_NOT_APPROVED"));
    expect(err.message).toContain("The manifest's bundle command `node x.mjs` is not approved");
    expect(installs).toEqual([]);
  });

  it("reports BUNDLE_FAILED when the bundle command fails", async () => {
    const { appDir, installs, t } = setup({ bundleExit: 2 });
    await expect(
      installCloudAppOp(t.ctx, { appId: "example-app", appDir }, t.emit),
    ).rejects.toEqual(withCode("BUNDLE_FAILED"));
    expect(installs).toEqual([]);
  });

  it("reports PROTOCOL_MISMATCH for an app that needs a newer platform", async () => {
    const { appDir, t } = setup({ manifest: { protocolMinVersion: "99.0.0" } });
    await expect(
      installCloudAppOp(t.ctx, { appId: "example-app", appDir }, t.emit),
    ).rejects.toEqual(withCode("PROTOCOL_MISMATCH"));
  });

  it("reports MANIFEST_INVALID for a folder that holds another app or no valid manifest", async () => {
    let { appDir, t } = setup();
    await expect(installCloudAppOp(t.ctx, { appId: "photos", appDir }, t.emit)).rejects.toEqual(
      withCode("MANIFEST_INVALID"),
    );
    ({ appDir, t } = setup({ manifest: { infraRequirements: "nope" } }));
    await expect(
      installCloudAppOp(t.ctx, { appId: "example-app", appDir }, t.emit),
    ).rejects.toEqual(withCode("MANIFEST_INVALID"));
  });

  it("reports INVALID_INPUT for a surface the manifest does not offer, or an unknown one", async () => {
    const { appDir, t } = setup();
    await expect(
      installCloudAppOp(t.ctx, { appId: "example-app", appDir, surfaces: ["mobile"] }, t.emit),
    ).rejects.toEqual(withCode("INVALID_INPUT"));
    await expect(
      installCloudAppOp(
        t.ctx,
        { appId: "example-app", appDir, surfaces: ["desktop" as never] },
        t.emit,
      ),
    ).rejects.toEqual(withCode("INVALID_INPUT"));
  });

  it("reports CONFIG_INCOMPLETE before the cloud data server is installed", async () => {
    const { appDir } = setup();
    const { s3Bucket: _s, ...partial } = INSTALLED_CONFIG;
    const t = testContext(starkeepDirWith(partial));
    await expect(
      installCloudAppOp(t.ctx, { appId: "example-app", appDir }, t.emit),
    ).rejects.toEqual(withCode("CONFIG_INCOMPLETE"));
  });

  it("reports INSTALL_FAILED with the takedown command for an exposed app", async () => {
    const { appDir, t } = setup({ probe: { ...QUIET_PROBE, exposed: true } as ProbeReport });
    const err = await installCloudAppOp(t.ctx, { appId: "example-app", appDir }, t.emit).catch(
      (e) => e,
    );
    expect(err).toEqual(withCode("INSTALL_FAILED"));
    expect(err.message).toContain("EXPOSED");
    expect(err.message).toContain("starkeep uninstall example-app --web");
  });

  it("reports NOT_SIGNED_IN once every local check passed", async () => {
    const { appDir } = setup();
    const t = testContext(
      starkeepDirWith(INSTALLED_CONFIG),
      { fetch: healthy() },
      { signedIn: false },
    );
    await expect(
      installCloudAppOp(t.ctx, { appId: "example-app", appDir }, t.emit),
    ).rejects.toEqual(withCode("NOT_SIGNED_IN"));
  });
});
