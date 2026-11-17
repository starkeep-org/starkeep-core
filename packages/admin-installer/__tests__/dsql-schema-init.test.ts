/**
 * The shared-schema DDL, as a statement sequence.
 *
 * This file exists mostly for one statement: the reverse label index. Its
 * column order is load-bearing in a way nothing in the code can enforce, was
 * settled by measurement against a live cluster, and is exactly the kind of
 * thing a later reader "tidies". Nothing else in CI would notice —
 * `initializeSharedSchema` only ever runs against a real DSQL endpoint.
 *
 *   (user_id, app_id, key, deleted_at, value, record_id) INCLUDE (record_type)
 *
 *   - `user_id` first, because every query is one user's: the broker's
 *     user-scoped compiler pins it by equality on every statement.
 *   - `deleted_at` third, BEFORE value, is what makes the live rows a
 *     contiguous range. DSQL has no partial indexes, so `WHERE deleted_at IS
 *     NULL` cannot be baked in; measured, this scans 20 index entries behind
 *     20,000 tombstones against 20,040 without.
 *   - `value` is in the key so an exact-value filter is a seek, not a scan.
 *   - `record_type` is an INCLUDE payload so the grant filter costs no heap
 *     access — and stays OUT of the sort order, which the pagination cursor
 *     is derived from.
 *
 * The pg pool and the DSQL token signer are module-mocked; everything else is
 * the real code.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = {
  /** Answers the pg_indexes / pg_roles EXISTS probes. */
  exists: false,
  /** Answers the sys.iam_pg_role_mappings EXISTS probe. */
  mappingExists: false,
  statements: [] as string[],
  /** A statement containing this text fails once with a DSQL OCC conflict. */
  conflictOnce: null as string | null,
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
    if (state.conflictOnce && text.includes(state.conflictOnce)) {
      state.conflictOnce = null;
      throw Object.assign(new Error("schema has been updated by another transaction (OC001)"), {
        code: "OC001",
      });
    }
    if (text.includes("FROM sys.iam_pg_role_mappings")) {
      return { rows: [{ exists: state.mappingExists }], rowCount: 1 };
    }
    if (text.includes("FROM pg_indexes") || text.includes("FROM pg_roles")) {
      return { rows: [{ exists: state.exists }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

import { initializeSharedSchema } from "../src/dsql-schema-init";

beforeEach(() => {
  state.exists = false;
  state.mappingExists = false;
  state.statements = [];
  state.conflictOnce = null;
});

async function init() {
  await initializeSharedSchema({
    hostname: "fake.dsql.us-east-1.on.aws",
    region: "us-east-1",
    stackPrefix: "starkeep",
    credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
  });
  return state.statements;
}

function find(statements: string[], needle: string): string | undefined {
  return statements.find((s) => s.includes(needle));
}

describe("shared.record_labels", () => {
  it("creates the table with the (user_id, record_id, app_id, key, value) primary key", async () => {
    const create = find(await init(), 'create table if not exists "shared"."record_labels"');
    expect(create).toBeTruthy();
    // app_id in the primary key is what keeps two different apps from ever
    // contending on the same row — the OCC problem that ruled out widening
    // shared.records instead. `value` is what makes a key set-valued: without
    // it, faces=Alice and faces=Bob cannot both exist and the value stops being
    // searchable at all.
    expect(create).toMatch(/primary key \("user_id", "record_id", "app_id", "key", "value"\)/);
    // No FK on record_id: DSQL has none, and orphans are tolerated.
    expect(create).not.toMatch(/references/i);
  });

  it("makes deleted_at the only nullable column", async () => {
    const create = find(await init(), 'create table if not exists "shared"."record_labels"')!;
    // `value` is NOT NULL because a PK column cannot be nullable — a bare flag
    // is the empty string, and row-present vs row-absent is what carried the
    // meaning all along. `deleted_at` stays nullable: tombstoned-or-not is
    // genuinely two-state, and it is pinned by equality in the reverse index
    // rather than participating in the cursor order.
    expect(create).toMatch(/"value" text not null/);
    expect(create).toMatch(/"deleted_at" text[,)]/);
    expect(create).toMatch(/"record_type" text not null/);
    expect(create).toMatch(/"node_id" text not null/);
  });

  it("builds the reverse index with the exact measured column order", async () => {
    const idx = find(await init(), "idx_record_labels_reverse");
    expect(idx).toBeTruthy();
    expect(idx).toContain(
      "ON shared.record_labels (user_id, app_id, key, deleted_at, value, record_id) INCLUDE (record_type)",
    );
    // ASYNC because DSQL rejects synchronous secondary indexes.
    expect(idx).toContain("CREATE INDEX ASYNC");
    // Not a partial index — DSQL rejects WHERE on CREATE INDEX, which is the
    // whole reason deleted_at is a key column.
    expect(idx).not.toMatch(/\bWHERE\b/);
  });

  it("builds the sync watermark index", async () => {
    const idx = find(await init(), "idx_record_labels_node_watermark");
    expect(idx).toContain("ON shared.record_labels (user_id, node_id, updated_at)");
  });

  it("guards every async index with IF NOT EXISTS rather than pre-checking", async () => {
    // DSQL accepts `IF NOT EXISTS` on the async form — probed against the live
    // cluster on 2026-09-10, after this file's header had claimed the opposite
    // for three months. The guard replaces a `pg_indexes` round trip per index
    // and the race between checking and creating.
    const statements = await init();
    const creates = statements.filter(
      (s) => s.includes("CREATE INDEX ASYNC") || s.includes("CREATE UNIQUE INDEX ASYNC"),
    );
    expect(creates.length).toBeGreaterThan(0);
    for (const create of creates) {
      expect(create).toMatch(/IF NOT EXISTS/i);
    }
    expect(statements.some((s) => s.includes("FROM pg_indexes"))).toBe(false);
  });

  it("grants DML to PUBLIC — per-app confinement is application-layer", async () => {
    // DSQL has no row-level security, so the per-type cut lives in both data
    // servers, identically to shared.records. Not a new weakening, but it has
    // to be deliberate.
    const statements = await init();
    expect(statements).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON shared.record_labels TO PUBLIC",
    );
  });
});

describe("shared.app_label_keys", () => {
  it("is keyed by (app_id, key) and carries the manifest description", async () => {
    const create = find(await init(), 'create table if not exists "shared"."app_label_keys"');
    expect(create).toBeTruthy();
    expect(create).toMatch(/primary key \("app_id", "key"\)/);
    expect(create).toMatch(/"description" text/);
  });

  it("is readable by every app, and writable only by the installer", async () => {
    // Discoverability is the entire reason keys are declared in a manifest
    // rather than counted at runtime: a registry only its owner can read buys
    // nothing over a counter. Which keys an app declares is public schema.
    const statements = await init();
    expect(statements).toContain("GRANT SELECT ON shared.app_label_keys TO PUBLIC");
    expect(
      statements.some((s) =>
        /GRANT INSERT, UPDATE, DELETE ON shared\.app_label_keys TO "starkeep_installer"/.test(s),
      ),
    ).toBe(true);
  });
});

describe("shared.object_availability", () => {
  it("is readable and upsertable by every app", async () => {
    // Every listing reads this table (loadAvailabilityForPage batches it per
    // page), so a missing grant is not a degraded feature — it is a 500 on
    // `GET /data/records` for every app. It shipped without any grant at all
    // and reached a real deployment that way.
    //
    // No DELETE: putAvailability is the only writer and it upserts; nothing
    // removes a row.
    const statements = await init();
    expect(statements).toContain(
      "GRANT SELECT, INSERT, UPDATE ON shared.object_availability TO PUBLIC",
    );
  });
});

describe("the shared node watermarks", () => {
  it("grant the labels' entries to PUBLIC, as the labels are, and the records' entries to no one here", async () => {
    // The records' entries are granted per app (dsql-ddl.ts), mirroring
    // shared.records; Drive's role holds them through the default privileges.
    const statements = await init();
    expect(statements).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON shared.node_watermarks_labels TO PUBLIC",
    );
    expect(statements.some((s) => /^GRANT .* shared\.node_watermarks_records /.test(s))).toBe(
      false,
    );
  });

  it("are keyed by owner, the source's type column and author, and backfilled after they exist", async () => {
    const statements = await init();
    for (const [table, key, source] of [
      ["node_watermarks_records", "type", "records"],
      ["node_watermarks_labels", "record_type", "record_labels"],
    ] as const) {
      const create = statements.findIndex((s) =>
        s.startsWith(`create table if not exists "shared"."${table}"`),
      );
      expect(statements[create]).toContain(`primary key ("user_id", "${key}", "node_id")`);
      const backfill = statements.findIndex((s) => s.startsWith(`insert into "shared"."${table}"`));
      expect(backfill).toBeGreaterThan(create);
      expect(statements[backfill]).toContain(
        `from "shared"."${source}" group by "user_id", "node_id", "${key}"`,
      );
      expect(statements[backfill]).toContain(
        `where "excluded"."updated_at" > "shared"."${table}"."updated_at"`,
      );
    }
  });
});

describe("every table in `shared` is granted to something", () => {
  it("leaves no table reachable only by its creator", async () => {
    // The generalisation of the bug above: a CREATE TABLE with no accompanying
    // GRANT looks complete in review and denies every caller at runtime. This
    // catches the next one without anyone having to remember the rule.
    const statements = await init();
    // Granted per-app at app-install time instead (dsql-ddl.ts), because the
    // verbs depend on that app's declared fileAccess — SELECT always, writes
    // only with readwrite. A blanket grant here would flatten that. The
    // records' node watermarks mirror the records' grants.
    const grantedPerApp = new Set(["records", "node_watermarks_records"]);

    const created = statements
      .map((s) => /create table if not exists "shared"\."([a-z_]+)"/i.exec(s)?.[1])
      .filter((t): t is string => Boolean(t))
      .filter((t) => !grantedPerApp.has(t));
    expect(created.length).toBeGreaterThan(0);
    const ungranted = created.filter(
      (table) => !statements.some((s) => /^GRANT /.test(s) && s.includes(`shared.${table} `)),
    );
    expect(ungranted, "tables created with no GRANT").toEqual([]);
  });
});

describe("delegation tables", () => {
  it("grants every delegation table to PUBLIC, as the broker reads them as Drive", async () => {
    const statements = await init();
    const created = statements
      .map((s) => /create table if not exists "delegation"\."([a-z_]+)"/i.exec(s)?.[1])
      .filter((t): t is string => Boolean(t));
    expect(created).toEqual(["grants", "authorizations", "refresh_tokens"]);
    for (const table of created) {
      expect(
        statements.some((s) => /^GRANT /.test(s) && s.includes(`delegation.${table} TO PUBLIC`)),
        table,
      ).toBe(true);
    }
  });

  it("declares the OAuth columns on grants and adds them to a table that predates them", async () => {
    const statements = await init();
    const create = find(statements, 'create table if not exists "delegation"."grants"')!;
    expect(create).toMatch(/"client_id" text/);
    expect(create).toMatch(/"redirect_host" text/);
    for (const column of ["client_id", "redirect_host"]) {
      expect(statements).toContain(
        `ALTER TABLE delegation.grants ADD COLUMN IF NOT EXISTS ${column} text`,
      );
    }
  });

  it("indexes the code hash and the refresh tokens' grant", async () => {
    const statements = await init();
    expect(find(statements, "idx_delegation_authorizations_code")).toMatch(/\(code_hash\)/);
    expect(find(statements, "idx_delegation_refresh_tokens_grant")).toMatch(/\(grant_id\)/);
  });
});

describe("shared.app_registry surfaces", () => {
  it("declares web_app and mobile_app, false by default, in CREATE TABLE", async () => {
    const create = find(await init(), 'create table if not exists "shared"."app_registry"')!;
    expect(create).toMatch(/"web_app" boolean default false not null/);
    expect(create).toMatch(/"mobile_app" boolean default false not null/);
  });

  it("adds both columns to an existing table, then fills them from what the install left", async () => {
    const statements = await init();
    const at = (pattern: RegExp) => statements.findIndex((s) => pattern.test(s));
    for (const column of ["web_app", "mobile_app"]) {
      expect(
        at(
          new RegExp(
            `ALTER TABLE shared\\.app_registry ADD COLUMN IF NOT EXISTS ${column} boolean`,
          ),
        ),
        column,
      ).toBeGreaterThan(at(/create table if not exists "shared"\."app_registry"/));
    }
    const fillWeb = statements.find((s) =>
      /^update "shared"\."app_registry" set "web_app"/.test(s),
    )!;
    expect(fillWeb).toMatch(/"step" = \$\d/);
    expect(fillWeb).toMatch(/where "web_app" is null$/);
    const fillMobile = statements.find((s) =>
      /^update "shared"\."app_registry" set "mobile_app"/.test(s),
    )!;
    expect(fillMobile).toMatch(/from "shared"\."app_mobile_identities"/);
    expect(fillMobile).toMatch(/where "mobile_app" is null$/);
    // Each fill runs after the ADD COLUMN that makes its column exist.
    expect(at(/^update "shared"\."app_registry" set "web_app"/)).toBeGreaterThan(
      at(/ADD COLUMN IF NOT EXISTS mobile_app/),
    );
  });
});

describe("shared.records stand-in columns", () => {
  it("declares the role, the fidelity and the slot in CREATE TABLE", async () => {
    const create = find(await init(), 'create table if not exists "shared"."records"')!;
    expect(create).toMatch(
      /"stand_in_role" text check \(stand_in_role IN \('canonical', 'smaller'\)\)/,
    );
    expect(create).toContain('"fidelity" integer');
    expect(create).toContain('"stand_in_slot" text');
  });

  it("adds each column to an existing table before the index names it", async () => {
    const statements = await init();
    const index = statements.findIndex((s) => s.includes("uq_records_stand_in_slot"));
    expect(index).toBeGreaterThan(-1);
    for (const column of ["stand_in_role", "fidelity", "stand_in_slot"]) {
      const add = statements.findIndex((s) =>
        s.includes(`ALTER TABLE shared.records ADD COLUMN IF NOT EXISTS ${column}`),
      );
      expect(add, column).toBeGreaterThan(-1);
      expect(add, column).toBeLessThan(index);
    }
  });

  it("keys the slot index on (user_id, parent_id, stand_in_slot) with NULLs distinct", async () => {
    const idx = find(await init(), "uq_records_stand_in_slot")!;
    expect(idx).toContain("CREATE UNIQUE INDEX ASYNC IF NOT EXISTS");
    // Per user: two users' stand-ins of one original never collide.
    expect(idx).toContain("ON shared.records (user_id, parent_id, stand_in_slot)");
    // NULLS NOT DISTINCT would make every ordinary record under one parent
    // collide, because their slot is null.
    expect(idx).not.toMatch(/NULLS NOT DISTINCT/i);
  });
});

describe("every owned table leads with its owner", () => {
  // The broker's user-scoped compiler fills and filters `user_id` on these
  // tables and puts it first in every conflict target; see storage-aurora-dsql's
  // `owner-scope.ts`. A table or index without it either fails every insert or
  // lets one user's row collide with another's.
  const OWNED = ["shared.records", "shared.record_labels", "shared.object_availability"];

  it.each(OWNED)("%s has the owner column and leads its primary key with it", async (table) => {
    const create = (await init()).find((s) =>
      s.startsWith(`create table if not exists "${table.replace(".", '"."')}"`),
    );
    expect(create, table).toBeDefined();
    expect(create).toMatch(/"user_id" text not null/);
    expect(create).toMatch(/primary key \("user_id", /);
  });

  it("leads every metadata table's primary key with the owner", async () => {
    const creates = (await init()).filter((s) =>
      /CREATE TABLE IF NOT EXISTS shared\.record_\w+_metadata/.test(s),
    );
    expect(creates.length).toBeGreaterThan(0);
    for (const create of creates) expect(create).toContain("PRIMARY KEY (user_id, record_id)");
  });

  it("leads every index on an owned table with the owner", async () => {
    const indexes = (await init()).filter(
      (s) =>
        /CREATE (UNIQUE )?INDEX/.test(s) &&
        /ON shared\.(records|record_labels|object_availability|record_\w+_metadata)\b/.test(s),
    );
    expect(indexes.length).toBeGreaterThan(0);
    for (const index of indexes) expect(index, index).toMatch(/\((user_id|"user_id"),/);
  });
});

describe("an optimistic-concurrency conflict", () => {
  it("replays the whole DDL and finishes", async () => {
    // DSQL answers OC001 when an async index build changed the catalog under
    // the next statement. Every statement is idempotent, so a replay converges.
    vi.spyOn(console, "log").mockImplementation(() => {});
    state.conflictOnce = 'create table if not exists "delegation"."authorizations"';
    const statements = await init();
    const creates = statements.filter((s) =>
      s.includes('create table if not exists "delegation"."authorizations"'),
    );
    expect(creates).toHaveLength(2);
    expect(statements.some((s) => s.includes('"delegation"."refresh_tokens"'))).toBe(true);
  });
});

describe("DSQL constraints the whole file lives inside", () => {
  it("issues every DDL statement separately", async () => {
    // Multiple DDL statements in one transaction is SQLSTATE 0A000 on DSQL,
    // and the pg driver runs a multi-statement string as one implicit
    // transaction — so a single blob would fail at runtime, in production,
    // where nothing else here can catch it.
    for (const statement of await init()) {
      const ddl = statement.match(/\b(create|alter|drop)\b/gi) ?? [];
      expect(ddl.length, statement).toBeLessThanOrEqual(1);
    }
  });

  it("uses no PL/pgSQL blocks", async () => {
    for (const statement of await init()) {
      expect(statement).not.toMatch(/DO \$\$/);
    }
  });
});

describe("the installer's IAM mapping", () => {
  it("grants without a revoke when no mapping row exists", async () => {
    const statements = await init();
    expect(statements.some((t) => t.startsWith('AWS IAM GRANT "starkeep_installer"'))).toBe(true);
    expect(statements.some((t) => t.startsWith("AWS IAM REVOKE"))).toBe(false);
  });

  // A recreated admin-app role keeps its ARN and gets a new principal id, so a
  // row left from the old role must be rebound, not trusted.
  it("revokes and re-grants when a mapping row already exists", async () => {
    state.mappingExists = true;
    const statements = await init();
    const revokeIdx = statements.findIndex((t) =>
      t.startsWith('AWS IAM REVOKE "starkeep_installer"'),
    );
    const grantIdx = statements.findIndex((t) =>
      t.startsWith('AWS IAM GRANT "starkeep_installer"'),
    );
    expect(revokeIdx).toBeGreaterThanOrEqual(0);
    expect(grantIdx).toBeGreaterThan(revokeIdx);
  });
});

describe("shared.retained_app_data", () => {
  it("records kept app data by app, readable by the installer role", async () => {
    const statements = await init();
    const create = find(statements, 'create table if not exists "shared"."retained_app_data"');
    expect(create).toMatch(/"app_id" text not null primary key/);
    expect(create).toMatch(/"tables_json" text not null/);
    expect(statements).toContain(
      'GRANT SELECT ON shared.retained_app_data TO "starkeep_installer"',
    );
  });
});
