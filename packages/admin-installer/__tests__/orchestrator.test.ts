/**
 * Install/uninstall state machine with every step implementation faked and an
 * in-memory step ledger standing in for the DSQL registry. Asserts the
 * contract the resume logic depends on: steps recorded pending→done in order,
 * a failed step recorded with its error, and completed steps skipped on
 * re-drive.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeLocalSchema } from "@starkeep/storage-sqlite";
import { insertAppRegistry } from "../src/local/registry";

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

// The HMAC secret the local sync supervisor would sign with — the value that
// must reach SSM (todo 39). Seeded into a real local registry below.
const PHOTOS_REGISTRY_SECRET = "a".repeat(64);

let dataDir: string;

// Seed a local-data-server-shaped sqlite DB with one app registry row, so the
// install path's `resolveLocalHmacSecret` reads a real secret to mirror.
function seedLocalRegistry(appId: string, hmacSecret: string): void {
  const db = new DatabaseSync(join(dataDir, "data.db"));
  try {
    initializeLocalSchema(db);
    insertAppRegistry(db, appId, photosManifest, hmacSecret);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  ledger.length = 0;
  vi.clearAllMocks();
  dataDir = mkdtempSync(join(tmpdir(), "orchestrator-test-"));
  // The creds dir and the data.db both resolve from STARKEEP_DIR (via
  // @starkeep/app-client). Point it at the temp dir.
  process.env.STARKEEP_DIR = dataDir;
  seedLocalRegistry("photos", PHOTOS_REGISTRY_SECRET);
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

  // Regression for todo 39: the secret mirrored to SSM must be the one the
  // local sync supervisor signs with — i.e. the local registry's hmac_secret —
  // not a separately-minted creds-file value. The old code minted its own
  // secret when the creds file was absent, so the cloud verifier ended up on a
  // key no local signer held and every signed request 401'd.
  it("mirrors the local registry secret to SSM and reconciles the creds file", async () => {
    await installApp({
      appId: "photos",
      manifest: photosManifest,
      zipBuffer: Buffer.from("zip"),
      version: "0.1.0",
      config,
      registryCredentials,
    });

    expect(vi.mocked(putAppCredsParameter)).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "photos", hmacSecret: PHOTOS_REGISTRY_SECRET }),
    );

    // The local creds file (@starkeep/app-client's source, and the app→LDS HMAC
    // key) is reconciled to the same registry secret, so all three stores agree.
    const credsPath = join(dataDir, "app-creds", "photos.json");
    const creds = JSON.parse(readFileSync(credsPath, "utf8")) as { hmacSecret: string };
    expect(creds.hmacSecret).toBe(PHOTOS_REGISTRY_SECRET);
  });

  // The other half of "the two stores can't silently diverge": if the app was
  // never installed locally, there is no signer secret to mirror. Minting one
  // for the cloud side would just recreate the drift, so install fails loudly.
  it("fails when the app has no local registry row instead of minting a divergent secret", async () => {
    const db = new DatabaseSync(join(dataDir, "data.db"));
    db.exec("DELETE FROM shared_app_registry");
    db.close();

    await expect(
      installApp({
        appId: "photos",
        manifest: photosManifest,
        zipBuffer: Buffer.from("zip"),
        version: "0.1.0",
        config,
        registryCredentials,
      }),
    ).rejects.toThrow(/no shared_app_registry row/);
    expect(vi.mocked(putAppCredsParameter)).not.toHaveBeenCalled();
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

    // Built-in Drive is installed locally (registry row + minted secret) at LDS
    // startup before any cloud install; seed that so the mirror step finds it.
    seedLocalRegistry("starkeep-drive", "b".repeat(64));
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

describe("HMAC secret (registry → SSM) provisioning", () => {
  it("overwrites a stale creds-file secret with the registry secret (the todo-39 drift)", async () => {
    // A creds file left holding a *different* secret than the registry is the
    // exact divergence that 401'd the cloud. Install mirrors the registry
    // secret (what the supervisor signs with) and brings the creds file back in
    // line, preserving any dataServerUrl admin-web wrote.
    mkdirSync(join(dataDir, "app-creds"), { recursive: true });
    writeFileSync(
      join(dataDir, "app-creds", "photos.json"),
      JSON.stringify({
        appId: "photos",
        hmacSecret: "stale-secret",
        dataServerUrl: "http://127.0.0.1:9999",
      }),
    );
    await installApp({
      appId: "photos",
      manifest: photosManifest,
      version: "0.1.0",
      config,
      registryCredentials,
    });
    expect(vi.mocked(putAppCredsParameter)).toHaveBeenCalledWith(
      expect.objectContaining({ hmacSecret: PHOTOS_REGISTRY_SECRET }),
    );
    const written = JSON.parse(
      readFileSync(join(dataDir, "app-creds", "photos.json"), "utf8"),
    ) as { hmacSecret: string; dataServerUrl: string };
    expect(written.hmacSecret).toBe(PHOTOS_REGISTRY_SECRET);
    expect(written.dataServerUrl).toBe("http://127.0.0.1:9999");
  });

  it("writes a fresh creds file (0600) from the registry secret when none exists", async () => {
    // The built-in-app path: no admin-web local-install route ran, so there's
    // no creds file yet — install seeds it from the registry secret.
    await installApp({
      appId: "photos",
      manifest: photosManifest,
      version: "0.1.0",
      config,
      registryCredentials,
    });
    const credsPath = join(dataDir, "app-creds", "photos.json");
    expect(existsSync(credsPath)).toBe(true);
    expect(statSync(credsPath).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(credsPath, "utf8")) as { hmacSecret: string };
    expect(written.hmacSecret).toBe(PHOTOS_REGISTRY_SECRET);
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
