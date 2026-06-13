/**
 * Install/uninstall state machine with every step implementation faked and an
 * in-memory step ledger standing in for the DSQL registry. Asserts the
 * contract the resume logic depends on: steps recorded pending→done in order,
 * a failed step recorded with its error, and completed steps skipped on
 * re-drive.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
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
    attachTempInstallInfraPolicy: vi.fn(async () => {}),
    detachTempInstallInfraPolicy: vi.fn(async () => {}),
    attachTempUninstallInfraPolicy: vi.fn(async () => {}),
    detachTempUninstallInfraPolicy: vi.fn(async () => {}),
    attachTempInstallDdlPolicy: vi.fn(async () => {}),
    detachTempInstallDdlPolicy: vi.fn(async () => {}),
    deleteAppRoleWithPolicies: vi.fn(async () => {}),
  };
});

vi.mock("../src/app-creds", () => ({
  appCredsParameterName: (p: string, a: string) => `/${p}/app-creds/${a}`,
  putAppCredsParameter: vi.fn(async () => {}),
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

vi.mock("../src/compute-stack", () => ({
  installComputeStack: vi.fn(async () => ({ outputs: {} })),
  uninstallComputeStack: vi.fn(async () => {}),
}));

import { installApp, uninstallApp, type InstallerConfig } from "../src/orchestrator";
import { createAppRole } from "../src/iam";
import { putAppCredsParameter } from "../src/app-creds";
import { putAppKeepFile, uploadAppBundle } from "../src/s3";
import { installComputeStack } from "../src/compute-stack";
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
  dataDir = mkdtempSync(join(tmpdir(), "orchestrator-test-"));
  process.env.STARKEEP_DATA_DIR = dataDir;
  return () => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.STARKEEP_DATA_DIR;
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
    expect(result.appRoleArn).toBe(
      "arn:aws:iam::111122223333:role/starkeep-app-photos-role",
    );
    expect(result.receipt).toEqual({ outputs: {} });
    expect(doneSteps("install")).toEqual(INSTALL_STEPS_WITH_COMPUTE);
    // every done is preceded by its pending
    for (const step of INSTALL_STEPS_WITH_COMPUTE) {
      const entries = ledger.filter((e) => e.step === step).map((e) => e.status);
      expect(entries, step).toEqual(["pending", "done"]);
    }
    expect(fakeRegistry.registerApp).toHaveBeenCalledWith(photosManifest, "photos");
    expect(fakeRegistry.close).toHaveBeenCalled();
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
    expect(doneSteps("install")).toEqual(INSTALL_STEPS_WITH_COMPUTE.slice(0, 5));

    // Re-drive: previously completed steps are skipped, the rest run.
    await installApp({
      appId: "photos",
      manifest: photosManifest,
      zipBuffer: Buffer.from("zip"),
      version: "0.1.0",
      config,
      registryCredentials,
    });
    expect(vi.mocked(createAppRole)).toHaveBeenCalledTimes(1);
    // put_app_creds_parameter is an alwaysRun step (reconciles SSM to the
    // current local secret), so it runs on every drive — once per drive here,
    // unlike createAppRole which is skipped once recorded done.
    expect(vi.mocked(putAppCredsParameter)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(putAppKeepFile)).toHaveBeenCalledTimes(2);
    expect(doneSteps("install")).toEqual(INSTALL_STEPS_WITH_COMPUTE);
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
      manifest: { ...photosManifest, infraRequirements: { ...photosManifest.infraRequirements, compute: { enabled: false, handlers: [] } } },
      version: "0.1.0",
      config,
      registryCredentials,
      allowReservedAppId: true,
    });
    expect(doneSteps("install").length).toBeGreaterThan(0);
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

describe("HMAC secret provisioning", () => {
  it("reuses an existing local creds secret", async () => {
    mkdirSync(join(dataDir, "app-creds"), { recursive: true });
    writeFileSync(
      join(dataDir, "app-creds", "photos.json"),
      JSON.stringify({ appId: "photos", hmacSecret: "pre-existing" }),
    );
    await installApp({
      appId: "photos",
      manifest: photosManifest,
      version: "0.1.0",
      config,
      registryCredentials,
    });
    expect(vi.mocked(putAppCredsParameter)).toHaveBeenCalledWith(
      expect.objectContaining({ hmacSecret: "pre-existing" }),
    );
  });

  it("mints and persists a fresh secret (0600) when none exists locally", async () => {
    await installApp({
      appId: "photos",
      manifest: photosManifest,
      version: "0.1.0",
      config,
      registryCredentials,
    });
    const credsPath = join(dataDir, "app-creds", "photos.json");
    expect(existsSync(credsPath)).toBe(true);
    const written = JSON.parse(readFileSync(credsPath, "utf8"));
    expect(written.hmacSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(credsPath).mode & 0o777).toBe(0o600);
    expect(vi.mocked(putAppCredsParameter)).toHaveBeenCalledWith(
      expect.objectContaining({ hmacSecret: written.hmacSecret }),
    );
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
    expect(doneSteps("uninstall")).toHaveLength(11);
  });
});
