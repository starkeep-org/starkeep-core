/**
 * `deleteAppDataCloud`, the action behind `cli:delete-app-data`: what it
 * refuses, what a cancelled run leaves alone, and the order a confirmed run
 * deletes in. AWS and DSQL are module-mocked; the DDL itself is pinned in
 * dsql-ddl.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const calls: string[] = [];

vi.mock("../src/session", () => ({
  roleChain: vi.fn(async (arns: string[]) => {
    calls.push(`assume ${arns.at(-1)}`);
    return { accessKeyId: "AK", secretAccessKey: "SK" };
  }),
}));

vi.mock("../src/iam", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/iam")>();
  return {
    ...real,
    attachTempInstallDdlPolicy: vi.fn(async () => void calls.push("attach ddl")),
    detachTempInstallDdlPolicy: vi.fn(async () => void calls.push("detach ddl")),
    createAppRole: vi.fn(async (input: { fileAccess: unknown[]; fileAccessAll: boolean }) => {
      calls.push(`create role files=${input.fileAccess.length} all=${input.fileAccessAll}`);
      return "arn:aws:iam::111122223333:role/starkeep-app-notes-role";
    }),
    deleteAppRoleWithPolicies: vi.fn(async () => void calls.push("delete role")),
  };
});

const counts = {
  retained: { appId: "notes", name: "Notes", tables: [], filesEnabled: true, retainedAt: "" },
  tables: [{ name: "notes", rowCount: 4 }],
  totalRows: 4,
  files: { count: 1, totalBytes: 10 },
};
let countAnswer: typeof counts | null = counts;

vi.mock("../src/dsql-ddl", () => ({
  countRetainedAppDataDsql: vi.fn(async () => {
    calls.push("count");
    return countAnswer;
  }),
  runAppDataDeleteDdl: vi.fn(async () => void calls.push("drop schema")),
}));

let failFiles = false;
vi.mock("../src/s3", () => ({
  deleteAppFilesObjects: vi.fn(async () => {
    calls.push("delete files");
    if (failFiles) throw new Error("S3 says no");
  }),
}));

import {
  AppStillInstalledError,
  NoRetainedCloudDataError,
  deleteAppDataCloud,
} from "../src/cloud-app-data";
import type { Registry } from "../src/registry";
import type { InstallerConfig } from "../src/orchestrator";

const config = {
  stackPrefix: "starkeep",
  region: "us-east-1",
  accountId: "111122223333",
  dsqlHostname: "fake.dsql",
  filesBucket: "files",
  managerRoleArn: "arn:manager",
  installDdlRoleArn: "arn:install-ddl",
  permissionsBoundaryArn: "arn:boundary",
  foundationalPermissionsBoundaryArn: "arn:foundational",
  userDataOwnerPermissionsBoundaryArn: "arn:udo",
} as InstallerConfig;

function registry(options: { installed?: string[]; kept?: string[] } = {}): Registry {
  return {
    listInstalledApps: async () => (options.installed ?? []).map((appId) => ({ appId }) as never),
    listRetainedAppData: async () =>
      (options.kept ?? ["notes"]).map((appId) => ({ appId, name: appId, retainedAt: "" })),
  } as unknown as Registry;
}

beforeEach(() => {
  calls.length = 0;
  countAnswer = counts;
  failFiles = false;
});

describe("deleteAppDataCloud", () => {
  it("refuses an app that is still installed, before touching AWS", async () => {
    await expect(
      deleteAppDataCloud({
        appId: "notes",
        config,
        registry: registry({ installed: ["notes"] }),
        confirm: async () => true,
      }),
    ).rejects.toBeInstanceOf(AppStillInstalledError);
    expect(calls).toEqual([]);
  });

  it("refuses an app the cloud keeps no data for", async () => {
    await expect(
      deleteAppDataCloud({
        appId: "notes",
        config,
        registry: registry({ kept: [] }),
        confirm: async () => true,
      }),
    ).rejects.toBeInstanceOf(NoRetainedCloudDataError);
    expect(calls).toEqual([]);
  });

  it("refuses a built-in app", async () => {
    await expect(
      deleteAppDataCloud({
        appId: "starkeep-drive",
        config,
        registry: registry({ kept: ["starkeep-drive"] }),
        confirm: async () => true,
      }),
    ).rejects.toThrow(/reserved/);
  });

  it("shows the counts, and a declined confirmation deletes nothing", async () => {
    const seen: unknown[] = [];
    const outcome = await deleteAppDataCloud({
      appId: "notes",
      config,
      registry: registry(),
      confirm: async (c) => {
        seen.push(c);
        return false;
      },
    });
    expect(outcome).toBe("cancelled");
    expect(seen).toEqual([counts]);
    expect(calls).not.toContain("delete files");
    expect(calls).not.toContain("drop schema");
    expect(calls.at(-1)).toBe("detach ddl");
  });

  it("deletes the files under a grantless app role, then the schema, then detaches", async () => {
    const outcome = await deleteAppDataCloud({
      appId: "notes",
      config,
      registry: registry(),
      confirm: async () => true,
    });
    expect(outcome).toBe("deleted");
    expect(calls).toEqual([
      "assume arn:manager",
      "attach ddl",
      "assume arn:install-ddl",
      "count",
      "create role files=0 all=false",
      "assume arn:aws:iam::111122223333:role/starkeep-app-notes-role",
      "delete files",
      "delete role",
      "drop schema",
      "detach ddl",
    ]);
  });

  // The schema and its record stay when the files fail, so the data stays
  // listed and a rerun finishes the job. The temporary role still goes.
  it("keeps the schema when deleting the files fails, and still deletes the role", async () => {
    failFiles = true;
    await expect(
      deleteAppDataCloud({
        appId: "notes",
        config,
        registry: registry(),
        confirm: async () => true,
      }),
    ).rejects.toThrow("S3 says no");
    expect(calls).toContain("delete role");
    expect(calls).not.toContain("drop schema");
    expect(calls.at(-1)).toBe("detach ddl");
  });
});
