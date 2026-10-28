/**
 * The cloud install registry and its surface columns, against real SQL.
 *
 * The broker admits a mobile app's attested key only while the app's
 * `shared.app_mobile_identities` row exists, and admin-web and the CLI read
 * `shared.app_registry.mobile_app`. `registerApp` and `removeSurfaces` write
 * the two in one transaction so they always agree; this suite holds them to
 * that after every step of an install's life. The orchestrator tests mock the
 * whole registry, so nothing else runs these statements.
 *
 * The second half runs schema init's fill of `web_app` and `mobile_app` over a
 * registry that predates the columns.
 *
 * `pg` is module-mocked onto one PGlite, and the DSQL token signer is mocked.
 * Schema init runs for real, but the mock forwards only its statements about
 * the three registry tables: the rest are DSQL-only (`CREATE INDEX ASYNC`, IAM
 * role mappings) or grants to roles PGlite has no reason to hold. So the tables
 * here are the ones `initializeSharedSchema` creates, column for column.
 *
 * See `~/projects/starkeep/findings-test-coverage-mobile-private-channel-2026-10-27.md`,
 * problems 2 and 3.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { AppManifest } from "@starkeep/admin-manifest";

const state = vi.hoisted(() => ({
  pg: null as unknown as import("@electric-sql/pglite").PGlite,
  /** Which statements reach PGlite; the rest answer with no rows. */
  forward: (_text: string): boolean => true,
}));

vi.mock("@aws-sdk/dsql-signer", () => ({
  DsqlSigner: class {
    async getDbConnectAuthToken() {
      return "fake-token";
    }
    async getDbConnectAdminAuthToken() {
      return "fake-admin-token";
    }
  },
}));

vi.mock("pg", () => {
  async function query(text: string, values?: unknown[]) {
    if (!state.forward(text)) return { rows: [], rowCount: 0, command: "SELECT" };
    const result = await state.pg.query(text, values);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
      command: text.trim().split(/\s+/)[0]!.toUpperCase(),
    };
  }
  class FakePool {
    async query(text: string, values?: unknown[]) {
      return query(text, values);
    }
    async connect() {
      return { query, release() {} };
    }
    async end() {}
    on() {
      return this;
    }
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

import { initializeSharedSchema } from "../../src/dsql-schema-init";
import { createDsqlRegistry, type Registry } from "../../src/registry";

const REGISTRY_TABLES = /\b(app_registry|app_install_steps|app_mobile_identities)\b/;

/** Schema init's statements about the registry tables, and the `shared` schema. */
function registryStatement(text: string): boolean {
  if (/^\s*grant\b/i.test(text)) return false;
  return /^\s*create schema/i.test(text) || REGISTRY_TABLES.test(text);
}

const connection = {
  hostname: "fake.dsql.us-east-1.on.aws",
  region: "us-east-1",
  stackPrefix: "starkeep",
  credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
};

async function initSchema(): Promise<void> {
  state.forward = registryStatement;
  try {
    await initializeSharedSchema({ ...connection, accountId: "123456789012" });
  } finally {
    state.forward = () => true;
  }
}

const photos: AppManifest = {
  id: "photos",
  name: "Photos",
  version: "0.1.0",
  mobile: {
    android: {
      package: "app.starkeep.photos",
      signingCertSha256: ["a".repeat(64)],
      callbackScheme: "starkeep-photos",
    },
  },
} as AppManifest;

/** The same app after a release that stops shipping the Android build. */
const photosWithoutAndroid: AppManifest = { ...photos, version: "0.2.0", mobile: undefined };

beforeEach(async () => {
  state.pg = new PGlite();
  await state.pg.waitReady;
});

afterEach(async () => {
  await state.pg.close();
});

interface Surfaces {
  web_app: boolean | null;
  mobile_app: boolean | null;
}

async function registryRow(appId: string): Promise<Surfaces | undefined> {
  const { rows } = await state.pg.query<Surfaces>(
    "SELECT web_app, mobile_app FROM shared.app_registry WHERE app_id = $1",
    [appId],
  );
  return rows[0];
}

async function identity(appId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await state.pg.query<Record<string, unknown>>(
    "SELECT android_package, callback_scheme FROM shared.app_mobile_identities WHERE app_id = $1",
    [appId],
  );
  return rows[0];
}

/** The two must agree: the broker reads the identity, admin-web the column. */
async function expectSurfaces(appId: string, web: boolean, mobile: boolean): Promise<void> {
  expect(await registryRow(appId)).toEqual({ web_app: web, mobile_app: mobile });
  if (mobile) {
    expect(await identity(appId)).toEqual({
      android_package: "app.starkeep.photos",
      callback_scheme: "starkeep-photos",
    });
  } else {
    expect(await identity(appId)).toBeUndefined();
  }
}

describe("the registry's surfaces", () => {
  let registry: Registry;

  beforeEach(async () => {
    await initSchema();
    registry = createDsqlRegistry(connection);
  });

  afterEach(async () => {
    await registry.close();
  });

  it("adds the mobile app to an installed web app, and removes each in turn", async () => {
    await registry.registerApp(photos, "photos", ["web"]);
    await expectSurfaces("photos", true, false);

    await registry.registerApp(photos, "photos", ["mobile"]);
    await expectSurfaces("photos", true, true);

    await registry.removeSurfaces("photos", ["web"]);
    await expectSurfaces("photos", false, true);

    await registry.removeSurfaces("photos", ["mobile"]);
    await expectSurfaces("photos", false, false);
    // The row, which stands for the data side, stays.
    expect((await registry.listInstalledApps()).map((a) => a.appId)).toEqual(["photos"]);
  });

  it("removing the mobile app leaves the web app installed", async () => {
    await registry.registerApp(photos, "photos", ["web", "mobile"]);
    await registry.removeSurfaces("photos", ["mobile"]);
    await expectSurfaces("photos", true, false);
  });

  it("reinstalling with a manifest that drops the Android build removes the mobile app", async () => {
    await registry.registerApp(photos, "photos", ["web", "mobile"]);
    await registry.registerApp(photosWithoutAndroid, "photos", ["web"]);
    await expectSurfaces("photos", true, false);
    expect((await registry.listInstalledApps())[0]).toMatchObject({
      version: "0.2.0",
      webApp: true,
      mobileApp: false,
    });
  });

  it("refuses the mobile app for a manifest with no mobile build, and writes nothing", async () => {
    await expect(registry.registerApp(photosWithoutAndroid, "photos", ["mobile"])).rejects.toThrow(
      /declares no mobile build/,
    );
    expect(await registryRow("photos")).toBeUndefined();
  });

  it("registers an app with neither surface, as Drive is", async () => {
    await registry.registerApp(
      { ...photosWithoutAndroid, id: "starkeep-drive" },
      "starkeep-drive",
      [],
    );
    await expectSurfaces("starkeep-drive", false, false);
  });

  it("reports both surfaces from listInstalledApps", async () => {
    await registry.registerApp(photos, "photos", ["mobile"]);
    expect(await registry.listInstalledApps()).toEqual([
      expect.objectContaining({ appId: "photos", name: "Photos", webApp: false, mobileApp: true }),
    ]);
  });

  it("clears both step ledgers for one app and keeps another app's", async () => {
    await registry.recordStep("photos", "install", "install_compute_stack", "done");
    await registry.recordStep("photos", "uninstall", "uninstall_compute_stack", "done");
    await registry.recordStep("memo", "install", "install_compute_stack", "done");
    await registry.clearSteps("photos");
    expect(await registry.getCompletedSteps("photos", "install")).toEqual(new Set());
    expect(await registry.getCompletedSteps("photos", "uninstall")).toEqual(new Set());
    expect(await registry.getCompletedSteps("memo", "install")).toEqual(
      new Set(["install_compute_stack"]),
    );
  });

  it("deletes the row, the identity and the ledger on a full uninstall", async () => {
    await registry.registerApp(photos, "photos", ["web", "mobile"]);
    await registry.recordStep("photos", "install", "register_app", "done");
    await registry.deleteAppRegistryEntry("photos");
    expect(await registryRow("photos")).toBeUndefined();
    expect(await identity("photos")).toBeUndefined();
    expect(await registry.getCompletedSteps("photos", "install")).toEqual(new Set());
  });
});

describe("schema init on a registry that predates the surface columns", () => {
  /** The three tables as an earlier schema init left them. */
  async function createOldRegistry(): Promise<void> {
    await state.pg.exec(`
      CREATE SCHEMA shared;
      CREATE TABLE shared.app_registry (
        app_id text PRIMARY KEY,
        version text NOT NULL,
        name text,
        installed_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE shared.app_install_steps (
        app_id text NOT NULL,
        operation text NOT NULL,
        step text NOT NULL,
        status text NOT NULL,
        error text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (app_id, operation, step)
      );
      CREATE TABLE shared.app_mobile_identities (
        app_id text PRIMARY KEY,
        android_package text NOT NULL,
        android_cert_digests text NOT NULL,
        callback_scheme text NOT NULL
      );
    `);
  }

  async function surfacesByApp(): Promise<Record<string, Surfaces>> {
    const { rows } = await state.pg.query<Surfaces & { app_id: string }>(
      "SELECT app_id, web_app, mobile_app FROM shared.app_registry ORDER BY app_id",
    );
    return Object.fromEntries(rows.map(({ app_id, ...s }) => [app_id, s]));
  }

  beforeEach(async () => {
    await createOldRegistry();
    await state.pg.exec(`
      INSERT INTO shared.app_registry (app_id, version) VALUES
        ('photos', '1'), ('memo', '1'), ('photos-mobile-only', '1'),
        ('half-installed', '1'), ('starkeep-drive', '1');
      INSERT INTO shared.app_install_steps (app_id, operation, step, status) VALUES
        ('photos', 'install', 'install_compute_stack', 'done'),
        ('memo', 'install', 'install_compute_stack', 'done'),
        ('half-installed', 'install', 'install_compute_stack', 'failed'),
        ('starkeep-drive', 'uninstall', 'install_compute_stack', 'done'),
        ('starkeep-drive', 'install', 'register_app', 'done');
      INSERT INTO shared.app_mobile_identities (app_id, android_package, android_cert_digests, callback_scheme) VALUES
        ('photos', 'app.starkeep.photos', '[]', 'starkeep-photos'),
        ('photos-mobile-only', 'app.starkeep.photos', '[]', 'starkeep-photos');
    `);
  });

  it("fills web_app from a completed compute stack and mobile_app from an identity row", async () => {
    await initSchema();
    expect(await surfacesByApp()).toEqual({
      photos: { web_app: true, mobile_app: true },
      memo: { web_app: true, mobile_app: false },
      "photos-mobile-only": { web_app: false, mobile_app: true },
      // A failed stack is no web app, and neither is a step of another operation.
      "half-installed": { web_app: false, mobile_app: false },
      "starkeep-drive": { web_app: false, mobile_app: false },
    });
  });

  it("leaves filled values alone on a later run", async () => {
    await initSchema();
    const registry = createDsqlRegistry(connection);
    try {
      await registry.removeSurfaces("photos", ["web", "mobile"]);
    } finally {
      await registry.close();
    }
    // The compute-stack step is still in the ledger; a second fill would set
    // web_app back to true.
    await initSchema();
    expect((await surfacesByApp())["photos"]).toEqual({ web_app: false, mobile_app: false });
  });

  it("lets the registry write the filled table", async () => {
    await initSchema();
    const registry = createDsqlRegistry(connection);
    try {
      await registry.registerApp(photos, "memo", ["mobile"]);
      expect((await surfacesByApp())["memo"]).toEqual({ web_app: true, mobile_app: true });
    } finally {
      await registry.close();
    }
  });
});

describe("schema init on a fresh cluster", () => {
  it("creates both surface columns false by default, and the fill changes nothing", async () => {
    await initSchema();
    await state.pg.exec(`INSERT INTO shared.app_registry (app_id, version) VALUES ('photos', '1')`);
    await initSchema();
    expect(await registryRow("photos")).toEqual({ web_app: false, mobile_app: false });
    const { rows } = await state.pg.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'shared' AND table_name = 'app_registry'
          AND column_name IN ('web_app', 'mobile_app') ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: "mobile_app", is_nullable: "NO" },
      { column_name: "web_app", is_nullable: "NO" },
    ]);
  });
});
