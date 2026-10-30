/**
 * Install/uninstall state machine with every step implementation faked and an
 * in-memory step ledger standing in for the DSQL registry. Asserts the
 * contract the resume logic depends on: steps recorded pending→done in order,
 * a failed step recorded with its error, and completed steps skipped on
 * re-drive.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface LedgerEntry {
  appId: string;
  operation: string;
  step: string;
  status: string;
  error?: string;
}

const ledger: LedgerEntry[] = [];

const fakeRegistry = {
  async recordStep(appId: string, operation: string, step: string, status: string, error?: string) {
    ledger.push({ appId, operation, step, status, error });
  },
  async getCompletedSteps(appId: string, operation: string) {
    return new Set(
      ledger
        .filter((e) => e.appId === appId && e.operation === operation && e.status === "done")
        .map((e) => e.step),
    );
  },
  registerApp: vi.fn(async () => {}),
  deleteAppRegistryEntry: vi.fn(async () => {}),
  removeSurfaces: vi.fn(async () => {}),
  clearSteps: vi.fn(async (appId: string) => {
    for (let i = ledger.length - 1; i >= 0; i--)
      if (ledger[i]!.appId === appId) ledger.splice(i, 1);
  }),
  listInstalledApps: vi.fn(async () => []),
  close: vi.fn(async () => {}),
};

vi.mock("../src/registry", () => ({
  createDsqlRegistry: () => fakeRegistry,
}));

vi.mock("../src/session", () => ({
  roleChain: vi.fn(async () => ({ accessKeyId: "AK", secretAccessKey: "SK" })),
}));

vi.mock("../src/iam", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/iam")>();
  return {
    ...real,
    createAppRole: vi.fn(async () => "arn:fake"),
    createAppExecRole: vi.fn(async () => "arn:fake-exec"),
    attachTempInstallInfraPolicy: vi.fn(async () => {}),
    detachTempInstallInfraPolicy: vi.fn(async () => {}),
    attachTempUninstallInfraPolicy: vi.fn(async () => {}),
    detachTempUninstallInfraPolicy: vi.fn(async () => {}),
    attachTempInstallDdlPolicy: vi.fn(async () => {}),
    detachTempInstallDdlPolicy: vi.fn(async () => {}),
    deleteAppRoleWithPolicies: vi.fn(async () => {}),
    deleteAppExecRoleWithPolicies: vi.fn(async () => {}),
  };
});

vi.mock("../src/app-creds", () => ({
  appCredsParameterName: (p: string, a: string) => `/${p}/app-creds/${a}`,
  ensureAppCredsParameter: vi.fn(async () => true),
  deleteAppCredsParameter: vi.fn(async () => {}),
}));

vi.mock("../src/dsql-ddl", () => ({
  runAppInstallDdl: vi.fn(async () => {}),
  runAppUninstallDdl: vi.fn(async () => {}),
}));

vi.mock("../src/s3", () => ({
  putAppKeepFile: vi.fn(async () => {}),
  uploadAppBundle: vi.fn(async () => {}),
  deleteAppFilesObjects: vi.fn(async () => {}),
  deleteAppArtifactsObjects: vi.fn(async () => {}),
}));

vi.mock("../src/app-sign-in-clients", () => ({
  setMobileAppCallback: vi.fn(async () => {}),
}));

vi.mock("../src/compute-stack", () => ({
  installComputeStack: vi.fn(async () => ({ outputs: {} })),
  uninstallComputeStack: vi.fn(async () => {}),
}));

import { installApp, uninstallApp, type InstallerConfig } from "../src/orchestrator";
import {
  createAppRole,
  createAppExecRole,
  deleteAppExecRoleWithPolicies,
  deleteAppRoleWithPolicies,
  attachTempInstallInfraPolicy,
  detachTempInstallInfraPolicy,
  attachTempInstallDdlPolicy,
  detachTempInstallDdlPolicy,
} from "../src/iam";
import { deleteAppCredsParameter, ensureAppCredsParameter } from "../src/app-creds";
import { runAppInstallDdl, runAppUninstallDdl } from "../src/dsql-ddl";
import { putAppKeepFile, uploadAppBundle } from "../src/s3";
import { installComputeStack, uninstallComputeStack } from "../src/compute-stack";
import { setMobileAppCallback } from "../src/app-sign-in-clients";
import { validateManifest, type AppManifest } from "@starkeep/admin-manifest";
import { readFileSync as rf } from "node:fs";
import { fileURLToPath } from "node:url";

const photosManifest: AppManifest = validateManifest(
  JSON.parse(
    rf(
      fileURLToPath(
        new URL("../../admin-manifest/__tests__/fixtures/photos.manifest.json", import.meta.url),
      ),
      "utf8",
    ),
  ),
).manifest!;

const config: InstallerConfig = {
  stackPrefix: "starkeep",
  region: "us-east-1",
  accountId: "111122223333",
  dsqlHostname: "fake.dsql",
  filesBucket: "starkeep-files-x",
  artifactsBucket: "starkeep-artifacts-x",
  pulumiStateBucket: "starkeep-pulumi-state-x",
  apiGatewayId: "api123",
  apiGatewayExecutionArn: "arn:aws:execute-api:us-east-1:111122223333:api123",
  authorizerId: "auth123",
  apiGatewayUrl: "https://api.example.com",
  permissionsBoundaryArn: "arn:boundary",
  foundationalPermissionsBoundaryArn: "arn:boundary-foundational",
  userDataOwnerPermissionsBoundaryArn: "arn:boundary-udo",
  managerRoleArn: "arn:manager",
  installDdlRoleArn: "arn:install-ddl",
  installInfraRoleArn: "arn:install-infra",
};

const registryCredentials = { accessKeyId: "AK", secretAccessKey: "SK" };

let dataDir: string;

beforeEach(() => {
  ledger.length = 0;
  vi.clearAllMocks();
  // An empty Starkeep directory: no data.db, no creds files. A cloud install
  // must need nothing from a local install and write nothing beside one.
  dataDir = mkdtempSync(join(tmpdir(), "orchestrator-test-"));
  process.env.STARKEEP_DIR = dataDir;
  return () => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.STARKEEP_DIR;
  };
});

function doneSteps(operation: string): string[] {
  // Distinct steps that reached "done", in first-completion order. Dedup
  // matters because alwaysRun steps (e.g. put_app_creds_parameter) re-record
  // "done" on every drive, so a resumed install legitimately logs them twice.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of ledger) {
    if (e.operation === operation && e.status === "done" && !seen.has(e.step)) {
      seen.add(e.step);
      out.push(e.step);
    }
  }
  return out;
}

const INSTALL_STEPS_WITH_COMPUTE = [
  "put_app_creds_parameter",
  "create_iam_role",
  "create_iam_exec_role",
  "attach_temp_install_ddl_policy",
  "run_dsql_ddl",
  "detach_temp_install_ddl_policy",
  "put_s3_keep_file",
  "attach_temp_install_infra_policy",
  "upload_bundle",
  "install_compute_stack",
  "detach_temp_install_infra_policy",
  "register_app",
];

describe("install", () => {
  it("drives every step pending→done in order and returns the role + receipt", async () => {
    const result = await installApp({
      appId: "photos",
      manifest: photosManifest,
      zipBuffer: Buffer.from("zip"),
      version: "0.1.0",
      config,
      registryCredentials,
    });
    expect(result.appRoleArn).toBe("arn:aws:iam::111122223333:role/starkeep-app-photos-role");
    expect(result.receipt).toEqual({ outputs: {} });
    expect(doneSteps("install")).toEqual(INSTALL_STEPS_WITH_COMPUTE);
    // every done is preceded by its pending
    for (const step of INSTALL_STEPS_WITH_COMPUTE) {
      const entries = ledger.filter((e) => e.step === step).map((e) => e.status);
      expect(entries, step).toEqual(["pending", "done"]);
    }
    expect(fakeRegistry.registerApp).toHaveBeenCalledWith(photosManifest, "photos", ["web"]);
    expect(fakeRegistry.close).toHaveBeenCalled();
  });

  // A cloud install once required a local install first, to mirror the local
  // registry's secret: the desktop's sync supervisor signed cloud requests with
  // it. The supervisor now presents the device token, so the cloud install
  // creates its own secret and touches nothing under STARKEEP_DIR.
  it("creates the HMAC secret in SSM with no local install, and writes nothing locally", async () => {
    await installApp({
      appId: "photos",
      manifest: photosManifest,
      zipBuffer: Buffer.from("zip"),
      version: "0.1.0",
      config,
      registryCredentials,
    });

    expect(vi.mocked(ensureAppCredsParameter)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ensureAppCredsParameter)).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "photos", stackPrefix: "starkeep", region: "us-east-1" }),
    );
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("records a mid-run failure and resumes from the failed step on re-drive", async () => {
    vi.mocked(putAppKeepFile).mockRejectedValueOnce(new Error("S3 hiccup"));
    await expect(
      installApp({
        appId: "photos",
        manifest: photosManifest,
        zipBuffer: Buffer.from("zip"),
        version: "0.1.0",
        config,
        registryCredentials,
      }),
    ).rejects.toThrow("S3 hiccup");
    const failed = ledger.find((e) => e.status === "failed");
    expect(failed).toMatchObject({ step: "put_s3_keep_file", error: "S3 hiccup" });
    // Everything up to but not including the step that threw.
    expect(doneSteps("install")).toEqual(
      INSTALL_STEPS_WITH_COMPUTE.slice(0, INSTALL_STEPS_WITH_COMPUTE.indexOf("put_s3_keep_file")),
    );

    // Re-drive: previously completed steps are skipped, the rest run.
    await installApp({
      appId: "photos",
      manifest: photosManifest,
      zipBuffer: Buffer.from("zip"),
      version: "0.1.0",
      config,
      registryCredentials,
    });
    expect(vi.mocked(createAppExecRole)).toHaveBeenCalledTimes(1);
    // put_app_creds_parameter and create_iam_role are alwaysRun steps (the
    // create-only put recreates a deleted secret; the role's policies are
    // rewritten), so they run on every drive — once per drive here, unlike
    // createAppExecRole which is skipped once recorded done.
    expect(vi.mocked(ensureAppCredsParameter)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createAppRole)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(putAppKeepFile)).toHaveBeenCalledTimes(2);
    expect(doneSteps("install")).toEqual(INSTALL_STEPS_WITH_COMPUTE);
  });

  // Regression: "Redeploy" must actually redeploy. upload_bundle and
  // install_compute_stack are the steps that push new Lambda code + gateway
  // routes; the first install records them "done", and without alwaysRun every
  // later redeploy silently skipped them — the app never updated no matter how
  // many times Redeploy was clicked. They must re-run on every drive (both are
  // idempotent: the bundle upload overwrites the same S3 key, and Pulumi up is a
  // no-op when nothing changed / updates the Lambda when the bundleHash does).
  it("re-runs upload_bundle and install_compute_stack on a redeploy of a fully-installed app", async () => {
    const drive = () =>
      installApp({
        appId: "photos",
        manifest: photosManifest,
        zipBuffer: Buffer.from("zip"),
        version: "0.1.0",
        config,
        registryCredentials,
      });

    await drive(); // first install records every step "done"
    expect(doneSteps("install")).toEqual(INSTALL_STEPS_WITH_COMPUTE);

    await drive(); // redeploy: every step is already recorded "done"

    // The two reconcile steps run again on the redeploy...
    expect(vi.mocked(uploadAppBundle)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(installComputeStack)).toHaveBeenCalledTimes(2);
    // ...and so do the install-infra temp-policy attach/detach: the policy is
    // torn down at the end of every run, so a redeploy that skipped re-attaching
    // it (because the ledger had the step "done") would run the alwaysRun
    // upload_bundle + install_compute_stack above under install-infra with no
    // grant → S3/Pulumi AccessDenied. They must re-attach and re-detach.
    expect(vi.mocked(attachTempInstallInfraPolicy)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(detachTempInstallInfraPolicy)).toHaveBeenCalledTimes(2);
    // ...while a normal one-shot step (create_iam_exec_role) stays skipped —
    // proving the ledger genuinely skips non-alwaysRun "done" steps, so the
    // counts above reflect alwaysRun and not a harness that never skips anything.
    expect(vi.mocked(createAppExecRole)).toHaveBeenCalledTimes(1);
    // Both re-runs also re-record "done" in the ledger (pending→done again).
    expect(
      ledger.filter((e) => e.step === "install_compute_stack" && e.status === "done"),
    ).toHaveLength(2);
  });

  // Regression: a redeploy must apply the manifest's schema. The first install
  // records run_dsql_ddl "done", and without alwaysRun no redeploy ever created
  // a table added later — the bytes-watermark table never reached Drive's
  // schema on 2026-10-15. Compute-less, like Drive, whose redeploy is the
  // second pass of a cloud data server redeploy.
  it("re-runs the DSQL DDL, with its temp policy, on a redeploy of a fully-installed app", async () => {
    const manifest: AppManifest = {
      ...photosManifest,
      infraRequirements: {
        ...photosManifest.infraRequirements,
        compute: { enabled: false, handlers: [] },
      },
    };
    const drive = () =>
      installApp({ appId: "photos", manifest, version: "0.1.0", config, registryCredentials });

    await drive();
    await drive();

    expect(vi.mocked(runAppInstallDdl)).toHaveBeenCalledTimes(2);
    // The detach at the end of every run removes the grant the DDL needs, so
    // the attach must run again too, and the detach with it.
    expect(vi.mocked(attachTempInstallDdlPolicy)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(detachTempInstallDdlPolicy)).toHaveBeenCalledTimes(2);
    const order = ledger
      .filter((e) => e.status === "done" && e.step.includes("ddl"))
      .map((e) => e.step);
    expect(order).toEqual([
      "attach_temp_install_ddl_policy",
      "run_dsql_ddl",
      "detach_temp_install_ddl_policy",
      "attach_temp_install_ddl_policy",
      "run_dsql_ddl",
      "detach_temp_install_ddl_policy",
    ]);
    expect(vi.mocked(createAppRole)).toHaveBeenCalledTimes(2);
  });

  it("rejects reserved app ids before recording any step, unless explicitly allowed", async () => {
    await expect(
      installApp({
        appId: "starkeep-drive",
        manifest: photosManifest,
        version: "0.1.0",
        config,
        registryCredentials,
      }),
    ).rejects.toThrow(/reserved for a built-in app/);
    expect(ledger).toEqual([]);

    await installApp({
      appId: "starkeep-drive",
      manifest: {
        ...photosManifest,
        infraRequirements: {
          ...photosManifest.infraRequirements,
          compute: { enabled: false, handlers: [] },
        },
      },
      version: "0.1.0",
      config,
      registryCredentials,
      allowReservedAppId: true,
    });
    expect(doneSteps("install").length).toBeGreaterThan(0);
    // Drive gets its secret whether or not the local-data-server ever ran: the
    // device branch reads the parameter as "Drive is installed".
    expect(vi.mocked(ensureAppCredsParameter)).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "starkeep-drive" }),
    );
  });

  it("rejects non-cloud-installable app ids", async () => {
    await expect(
      installApp({
        appId: "Bad/Id",
        manifest: photosManifest,
        version: "0.1.0",
        config,
        registryCredentials,
      }),
    ).rejects.toThrow(/not cloud-installable/);
  });

  it("skips infra steps entirely for compute-less manifests", async () => {
    const manifest: AppManifest = {
      ...photosManifest,
      infraRequirements: {
        ...photosManifest.infraRequirements,
        compute: { enabled: false, handlers: [] },
      },
    };
    await installApp({
      appId: "photos",
      manifest,
      version: "0.1.0",
      config,
      registryCredentials,
    });
    expect(doneSteps("install")).toEqual([
      // No create_iam_exec_role: this manifest has no compute, so there is no
      // Lambda for an exec role to be the identity of.
      "put_app_creds_parameter",
      "create_iam_role",
      "attach_temp_install_ddl_policy",
      "run_dsql_ddl",
      "detach_temp_install_ddl_policy",
      "put_s3_keep_file",
      "register_app",
    ]);
    expect(vi.mocked(uploadAppBundle)).not.toHaveBeenCalled();
    expect(vi.mocked(installComputeStack)).not.toHaveBeenCalled();
  });

  it("skips upload_bundle when no zip is provided but compute is enabled", async () => {
    await installApp({
      appId: "photos",
      manifest: photosManifest,
      version: "0.1.0",
      config,
      registryCredentials,
    });
    expect(vi.mocked(uploadAppBundle)).not.toHaveBeenCalled();
    expect(vi.mocked(installComputeStack)).toHaveBeenCalled();
    expect(doneSteps("install")).not.toContain("upload_bundle");
  });
});

describe("uninstall", () => {
  it("drives the uninstall ledger in order for a compute app", async () => {
    await uninstallApp({
      appId: "photos",
      manifest: photosManifest,
      config,
      registryCredentials,
    });
    expect(doneSteps("uninstall")).toEqual([
      "attach_temp_uninstall_infra_policy",
      "uninstall_compute_stack",
      "delete_s3_artifacts",
      "detach_temp_uninstall_infra_policy",
      "delete_s3_files",
      "attach_temp_install_ddl_policy",
      "run_dsql_uninstall_ddl",
      "detach_temp_install_ddl_policy",
      "delete_app_registry",
      "delete_iam_role",
      "delete_iam_exec_role",
      "delete_app_creds_parameter",
    ]);
    expect(fakeRegistry.deleteAppRegistryEntry).toHaveBeenCalledWith("photos");
  });

  it("install steps don't shadow uninstall steps (separate ledgers per operation)", async () => {
    await installApp({
      appId: "photos",
      manifest: photosManifest,
      version: "0.1.0",
      config,
      registryCredentials,
    });
    await uninstallApp({
      appId: "photos",
      manifest: photosManifest,
      config,
      registryCredentials,
    });
    // Uninstall ran fully even though install's ledger was complete.
    expect(doneSteps("uninstall")).toHaveLength(12);
  });
});

describe("an app that ships a mobile build", () => {
  const mobileManifest: AppManifest = {
    ...photosManifest,
    mobile: {
      android: {
        package: "app.starkeep.photos",
        signingCertSha256: ["a".repeat(64)],
        callbackScheme: "starkeep-photos",
      },
    },
  };
  const mobileSignIn = { userPoolId: "us-east-1_pool", mobileAppsClientId: "mobile1" };
  const COMPUTE_STEPS = [
    "create_iam_exec_role",
    "attach_temp_install_infra_policy",
    "upload_bundle",
    "install_compute_stack",
    "detach_temp_install_infra_policy",
  ];

  it("installs every surface the manifest offers when none is named", async () => {
    await installApp({
      appId: "photos",
      manifest: mobileManifest,
      zipBuffer: Buffer.from("zip"),
      version: "0.1.0",
      config: { ...config, mobileSignIn },
      registryCredentials,
    });
    expect(fakeRegistry.registerApp).toHaveBeenCalledWith(mobileManifest, "photos", [
      "web",
      "mobile",
    ]);
    expect(setMobileAppCallback).toHaveBeenCalledWith(
      { region: "us-east-1", ...mobileSignIn },
      "starkeep-photos",
      true,
    );
    const steps = doneSteps("install");
    expect(steps.indexOf("add_mobile_callback")).toBe(steps.indexOf("register_app") - 1);
  });

  it("installs the mobile app with the whole data side and no compute", async () => {
    await installApp({
      appId: "photos",
      manifest: mobileManifest,
      version: "0.1.0",
      config: { ...config, mobileSignIn },
      registryCredentials,
      surfaces: ["mobile"],
    });
    expect(doneSteps("install")).toEqual([
      "put_app_creds_parameter",
      "create_iam_role",
      "attach_temp_install_ddl_policy",
      "run_dsql_ddl",
      "detach_temp_install_ddl_policy",
      "put_s3_keep_file",
      "add_mobile_callback",
      "register_app",
    ]);
    expect(runAppInstallDdl).toHaveBeenCalledWith(
      expect.anything(),
      "photos",
      mobileManifest.infraRequirements.fileAccess,
      mobileManifest.infraRequirements.fileAccessAll,
      mobileManifest.infraRequirements.appSpecificSyncable.tables,
      mobileManifest.infraRequirements.appSpecificSyncable.files,
      mobileManifest.infraRequirements.labelKeys,
    );
    expect(createAppExecRole).not.toHaveBeenCalled();
    expect(installComputeStack).not.toHaveBeenCalled();
    expect(fakeRegistry.registerApp).toHaveBeenCalledWith(mobileManifest, "photos", ["mobile"]);
  });

  it("creates the HMAC secret on a mobile-only install", async () => {
    await installApp({
      appId: "photos",
      manifest: mobileManifest,
      version: "0.1.0",
      config: { ...config, mobileSignIn },
      registryCredentials,
      surfaces: ["mobile"],
    });
    expect(ensureAppCredsParameter).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "photos" }),
    );
    expect(doneSteps("install")).toContain("put_app_creds_parameter");
  });

  it("adds the web app to an installed mobile app, and records it", async () => {
    const install = (surfaces: Array<"web" | "mobile">) =>
      installApp({
        appId: "photos",
        manifest: mobileManifest,
        zipBuffer: Buffer.from("zip"),
        version: "0.1.0",
        config: { ...config, mobileSignIn },
        registryCredentials,
        surfaces,
      });
    await install(["mobile"]);
    await install(["web"]);
    for (const step of COMPUTE_STEPS) expect(doneSteps("install"), step).toContain(step);
    expect(createAppExecRole).toHaveBeenCalledTimes(1);
    // register_app runs again, so the row records the web app too.
    expect(fakeRegistry.registerApp).toHaveBeenLastCalledWith(mobileManifest, "photos", ["web"]);
  });

  it("refuses a surface the manifest does not offer, before any step", async () => {
    await expect(
      installApp({
        appId: "photos",
        manifest: photosManifest,
        version: "0.1.0",
        config: { ...config, mobileSignIn },
        registryCredentials,
        surfaces: ["mobile"],
      }),
    ).rejects.toThrow(/declares no mobile build/);
    const computeLess: AppManifest = {
      ...mobileManifest,
      infraRequirements: {
        ...mobileManifest.infraRequirements,
        compute: { enabled: false, handlers: [] },
      },
    };
    await expect(
      installApp({
        appId: "photos",
        manifest: computeLess,
        version: "0.1.0",
        config: { ...config, mobileSignIn },
        registryCredentials,
        surfaces: ["web"],
      }),
    ).rejects.toThrow(/no web app/);
    expect(ledger).toEqual([]);
  });

  it("refuses the mobile app on a deployment with no mobile-apps client, before any step", async () => {
    await expect(
      installApp({
        appId: "photos",
        manifest: mobileManifest,
        version: "0.1.0",
        config,
        registryCredentials,
      }),
    ).rejects.toThrow(/Reinstall the cloud data server/);
    expect(ledger).toEqual([]);
  });

  it("installs the web app alone on a deployment with no mobile-apps client", async () => {
    await installApp({
      appId: "photos",
      manifest: mobileManifest,
      version: "0.1.0",
      config,
      registryCredentials,
      surfaces: ["web"],
    });
    expect(setMobileAppCallback).not.toHaveBeenCalled();
    expect(fakeRegistry.registerApp).toHaveBeenCalledWith(mobileManifest, "photos", ["web"]);
  });

  it("removes the web app alone and keeps the data side", async () => {
    await uninstallApp({
      appId: "photos",
      manifest: mobileManifest,
      config: { ...config, mobileSignIn },
      registryCredentials,
      surfaces: ["web"],
    });
    expect(uninstallComputeStack).toHaveBeenCalled();
    expect(deleteAppExecRoleWithPolicies).toHaveBeenCalled();
    expect(fakeRegistry.removeSurfaces).toHaveBeenCalledWith("photos", ["web"]);
    // The data side stays: role, schema, files, secret and registry row.
    expect(deleteAppRoleWithPolicies).not.toHaveBeenCalled();
    expect(runAppUninstallDdl).not.toHaveBeenCalled();
    expect(deleteAppCredsParameter).not.toHaveBeenCalled();
    expect(fakeRegistry.deleteAppRegistryEntry).not.toHaveBeenCalled();
    // The mobile app's parts stay too.
    expect(setMobileAppCallback).not.toHaveBeenCalled();
    // Both ledgers are forgotten, so a later install re-creates the exec role.
    expect(fakeRegistry.clearSteps).toHaveBeenCalledWith("photos");
    expect(ledger).toEqual([]);
  });

  it("removes the mobile app alone and keeps the data side and the web app", async () => {
    await uninstallApp({
      appId: "photos",
      manifest: mobileManifest,
      config: { ...config, mobileSignIn },
      registryCredentials,
      surfaces: ["mobile"],
    });
    expect(setMobileAppCallback).toHaveBeenCalledWith(
      { region: "us-east-1", ...mobileSignIn },
      "starkeep-photos",
      false,
    );
    expect(fakeRegistry.removeSurfaces).toHaveBeenCalledWith("photos", ["mobile"]);
    expect(uninstallComputeStack).not.toHaveBeenCalled();
    expect(deleteAppExecRoleWithPolicies).not.toHaveBeenCalled();
    expect(deleteAppRoleWithPolicies).not.toHaveBeenCalled();
    expect(runAppUninstallDdl).not.toHaveBeenCalled();
    expect(fakeRegistry.deleteAppRegistryEntry).not.toHaveBeenCalled();
  });

  it("removes everything, the callback included, on a plain uninstall", async () => {
    await uninstallApp({
      appId: "photos",
      manifest: mobileManifest,
      config: { ...config, mobileSignIn },
      registryCredentials,
    });
    expect(setMobileAppCallback).toHaveBeenCalledWith(
      { region: "us-east-1", ...mobileSignIn },
      "starkeep-photos",
      false,
    );
    expect(doneSteps("uninstall")).toContain("remove_mobile_callback");
    expect(uninstallComputeStack).toHaveBeenCalled();
    expect(runAppUninstallDdl).toHaveBeenCalled();
    expect(deleteAppRoleWithPolicies).toHaveBeenCalled();
    expect(fakeRegistry.deleteAppRegistryEntry).toHaveBeenCalledWith("photos");
    expect(fakeRegistry.removeSurfaces).not.toHaveBeenCalled();
  });
});
