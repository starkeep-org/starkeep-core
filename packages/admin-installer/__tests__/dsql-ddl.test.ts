/**
 * Statement-sequence tests for the per-app install/uninstall DDL.
 *
 * DSQL is structurally unavailable below Tier 3, so the pg Pool and the DSQL
 * token signer are module-mocked; everything else (Kysely composition, probe
 * branching, grant derivation) is the real code. The fake pool records every
 * statement and answers the EXISTS-probes from a configurable state, which is
 * exactly the seam the DDL's idempotency logic branches on.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = {
  pgRoleExists: false,
  iamMappingExists: false,
  statements: [] as string[],
};

vi.mock("@aws-sdk/dsql-signer", () => ({
  DsqlSigner: class {
    async getDbConnectAdminAuthToken() {
      return "fake-admin-token";
    }
  },
}));

vi.mock("pg", () => {
  class FakePool {
    async query(text: string) {
      return handleQuery(text);
    }
    async connect() {
      return {
        query: async (text: string) => handleQuery(text),
        release() {},
      };
    }
    async end() {}
    on() {
      return this;
    }
  }
  function handleQuery(text: string) {
    state.statements.push(text.replace(/\s+/g, " ").trim());
    if (text.includes("FROM pg_roles")) {
      return { rows: [{ exists: state.pgRoleExists }], rowCount: 1 };
    }
    if (text.includes("FROM sys.iam_pg_role_mappings")) {
      return { rows: [{ exists: state.iamMappingExists }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

import { runAppInstallDdl, runAppUninstallDdl, type DsqlDdlOptions } from "../src/dsql-ddl";
import { validateManifest } from "@starkeep/admin-manifest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const photosManifest = validateManifest(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../admin-manifest/__tests__/fixtures/photos.manifest.json", import.meta.url),
      ),
      "utf8",
    ),
  ),
).manifest!;

const opts: DsqlDdlOptions = {
  hostname: "fake.dsql.us-east-1.on.aws",
  region: "us-east-1",
  stackPrefix: "starkeep",
  accountId: "111122223333",
  credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
};

beforeEach(() => {
  state.pgRoleExists = false;
  state.iamMappingExists = false;
  state.statements = [];
});

function stmts(): string[] {
  // Drop the connection probe; the sequence under test starts after connect.
  return state.statements.filter((s) => s !== "SELECT 1");
}

async function installPhotos() {
  const ir = photosManifest.infraRequirements;
  await runAppInstallDdl(
    opts,
    "photos",
    ir.fileAccess,
    ir.fileAccessAll,
    ir.appSpecificSyncable.tables,
    ir.appSpecificSyncable.files,
  );
}

describe("install DDL for the photos manifest", () => {
  it("creates the PG role via probe-then-create and maps the IAM role to it", async () => {
    await installPhotos();
    const s = stmts();
    const probeIdx = s.findIndex((t) => t.includes("FROM pg_roles"));
    const createIdx = s.findIndex((t) => t === 'CREATE ROLE "starkeep_app_photos" LOGIN');
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(probeIdx);
    expect(s).toContain('GRANT "starkeep_app_photos" TO admin');
    expect(s).toContain(
      `AWS IAM GRANT "starkeep_app_photos" TO 'arn:aws:iam::111122223333:role/starkeep-app-photos-role'`,
    );
  });

  it("skips CREATE ROLE and AWS IAM GRANT when the probes report existing", async () => {
    state.pgRoleExists = true;
    state.iamMappingExists = true;
    await installPhotos();
    const s = stmts();
    expect(s.some((t) => t.startsWith("CREATE ROLE"))).toBe(false);
    expect(s.some((t) => t.startsWith("AWS IAM GRANT"))).toBe(false);
  });

  it("creates the private schema with ownership and default privileges", async () => {
    await installPhotos();
    const s = stmts();
    expect(s.some((t) => t.includes("CREATE SCHEMA IF NOT EXISTS app_photos") && t.includes("AUTHORIZATION starkeep_app_photos"))).toBe(true);
    expect(s.some((t) => t.includes("GRANT ALL PRIVILEGES ON SCHEMA app_photos"))).toBe(true);
    expect(s.some((t) => t.includes("ALTER DEFAULT PRIVILEGES IN SCHEMA app_photos"))).toBe(true);
  });

  it("grants shared.records read + write (photos is readwrite)", async () => {
    await installPhotos();
    const s = stmts();
    expect(s.some((t) => t.includes("GRANT USAGE ON SCHEMA shared TO starkeep_app_photos"))).toBe(true);
    expect(s.some((t) => t.includes("GRANT SELECT ON shared.records TO starkeep_app_photos"))).toBe(true);
    expect(s.some((t) => t.includes("GRANT INSERT, UPDATE, DELETE ON shared.records TO starkeep_app_photos"))).toBe(true);
  });

  it("grants the image metadata table read and write", async () => {
    await installPhotos();
    const s = stmts();
    expect(s.some((t) => t.includes("GRANT SELECT ON shared.record_image_metadata"))).toBe(true);
    expect(s.some((t) => t.includes("GRANT INSERT, UPDATE ON shared.record_image_metadata"))).toBe(true);
    // photos declares only image extensions — no other category may appear
    expect(s.some((t) => t.includes("record_video_metadata"))).toBe(false);
  });

  it("upserts one access_grants row per declared type", async () => {
    await installPhotos();
    const grantInserts = stmts().filter((t) => t.includes('insert into "shared"."access_grants"'));
    const typeCount = photosManifest.infraRequirements.fileAccess.reduce(
      (n, e) => n + e.types.length,
      0,
    );
    expect(grantInserts).toHaveLength(typeCount); // 9 types for photos
    for (const t of grantInserts) {
      expect(t).toContain('on conflict ("app_id", "type_id") do update');
    }
  });

  it("creates app syncable tables with reserved HLC columns, async index, and DML grant", async () => {
    await installPhotos();
    const s = stmts();
    const createTable = s.find((t) => t.includes('create table if not exists "app_photos"."image_enriched"'));
    expect(createTable).toBeDefined();
    expect(createTable).toContain('"updated_at" text not null');
    expect(createTable).toContain('"deleted_at" text');
    expect(createTable).toContain('primary key ("record_id")');
    expect(s.some((t) => t.includes('CREATE INDEX ASYNC IF NOT EXISTS "idx_app_photos_image_enriched_updated_at"'))).toBe(true);
    expect(s.some((t) => t.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON app_photos."image_enriched"'))).toBe(true);
  });

  it("creates the reserved file-records table when files sync is enabled, and registers the namespace", async () => {
    await installPhotos();
    const s = stmts();
    expect(s.some((t) => t.includes('"app_photos"."_starkeep_sync_records"') && t.startsWith("create table"))).toBe(true);
    const ns = s.find((t) => t.includes('insert into "shared"."app_syncable_namespaces"'));
    expect(ns).toBeDefined();
    expect(ns).toContain('on conflict ("app_id") do update');
  });
});

describe("install DDL for Drive (fileAccessAll)", () => {
  it("writes zero access_grants rows but grants every category metadata table", async () => {
    await runAppInstallDdl(opts, "starkeep-drive", [], true, [], false);
    const s = stmts();
    expect(s.some((t) => t.includes('insert into "shared"."access_grants"'))).toBe(false);
    // Full write on shared.records
    expect(s.some((t) => t.includes("GRANT INSERT, UPDATE, DELETE ON shared.records TO starkeep_app_starkeep_drive"))).toBe(true);
    // Every grantable category's metadata table is granted (spot-check a few)
    for (const cat of ["image", "video", "document"]) {
      expect(s.some((t) => t.includes(`GRANT INSERT, UPDATE ON shared.record_${cat}_metadata`)), cat).toBe(true);
    }
    // No namespace row: Drive has no app-specific syncable data
    expect(s.some((t) => t.includes("app_syncable_namespaces"))).toBe(false);
  });
});

describe("read-only app install DDL", () => {
  it("grants SELECT but never INSERT/UPDATE/DELETE on shared.records", async () => {
    await runAppInstallDdl(
      opts,
      "viewer",
      [{ types: ["document/pdf"], access: "read", metadataWrite: false, rationale: "t" }],
      false,
    );
    const s = stmts();
    expect(s.some((t) => t.includes("GRANT SELECT ON shared.records"))).toBe(true);
    expect(s.some((t) => t.includes("GRANT INSERT, UPDATE, DELETE ON shared.records"))).toBe(false);
    // Metadata: read yes, write no (no readwrite, no metadataWrite)
    expect(s.some((t) => t.includes("GRANT SELECT ON shared.record_document_metadata"))).toBe(true);
    expect(s.some((t) => t.includes("GRANT INSERT, UPDATE ON shared.record_document_metadata"))).toBe(false);
  });

  it("metadata_write without readwrite still grants metadata-table writes (thumbnail-worker shape)", async () => {
    await runAppInstallDdl(
      opts,
      "thumbs",
      [{ types: ["image/jpeg"], access: "read", metadataWrite: true, rationale: "t" }],
      false,
    );
    const s = stmts();
    expect(s.some((t) => t.includes("GRANT INSERT, UPDATE, DELETE ON shared.records"))).toBe(false);
    expect(s.some((t) => t.includes("GRANT INSERT, UPDATE ON shared.record_image_metadata"))).toBe(true);
  });
});

describe("uninstall DDL", () => {
  it("revokes grants, deletes registry rows, drops schema and role — shared tables survive", async () => {
    state.pgRoleExists = true;
    state.iamMappingExists = true;
    const ir = photosManifest.infraRequirements;
    await runAppUninstallDdl(opts, "photos", ir.fileAccess, ir.fileAccessAll);
    const s = stmts();
    expect(s.some((t) => t.includes("REVOKE ALL ON shared.records FROM starkeep_app_photos"))).toBe(true);
    expect(s.some((t) => t.includes("REVOKE ALL ON shared.record_image_metadata"))).toBe(true);
    expect(s.some((t) => t.includes("REVOKE USAGE ON SCHEMA shared FROM starkeep_app_photos"))).toBe(true);
    expect(s.some((t) => t.includes('delete from "shared"."access_grants" where "app_id" ='))).toBe(true);
    expect(s.some((t) => t.includes('delete from "shared"."app_syncable_namespaces"'))).toBe(true);
    expect(s).toContain("DROP SCHEMA IF EXISTS app_photos CASCADE");
    expect(s).toContain(
      `AWS IAM REVOKE "starkeep_app_photos" FROM 'arn:aws:iam::111122223333:role/starkeep-app-photos-role'`,
    );
    expect(s).toContain('DROP ROLE "starkeep_app_photos"');
    // Never drops shared schema objects
    expect(s.some((t) => t.includes("DROP TABLE"))).toBe(false);
    expect(s.some((t) => t.includes("DROP SCHEMA shared"))).toBe(false);
  });

  it("skips AWS IAM REVOKE and DROP ROLE when probes report absent", async () => {
    await runAppUninstallDdl(opts, "photos", [], false);
    const s = stmts();
    expect(s.some((t) => t.startsWith("AWS IAM REVOKE"))).toBe(false);
    expect(s.some((t) => t.startsWith("DROP ROLE"))).toBe(false);
  });
});
