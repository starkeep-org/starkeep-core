/**
 * The shared-schema DDL, as a statement sequence.
 *
 * This file exists mostly for one statement: the reverse label index. Its
 * column order is load-bearing in a way nothing in the code can enforce, was
 * settled by measurement against a live cluster, and is exactly the kind of
 * thing a later reader "tidies". Nothing else in CI would notice —
 * `initializeSharedSchema` only ever runs against a real DSQL endpoint.
 *
 *   (app_id, key, deleted_at, value, record_id) INCLUDE (record_type)
 *
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
  state.statements = [];
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
  it("creates the table with the (record_id, app_id, key) primary key", async () => {
    const create = find(await init(), 'create table if not exists "shared"."record_labels"');
    expect(create).toBeTruthy();
    // app_id in the primary key is what keeps two different apps from ever
    // contending on the same row — the OCC problem that ruled out widening
    // shared.records instead.
    expect(create).toMatch(/primary key \("record_id", "app_id", "key"\)/);
    // No FK on record_id: DSQL has none, and orphans are tolerated.
    expect(create).not.toMatch(/references/i);
  });

  it("makes value and deleted_at nullable, and everything else NOT NULL", async () => {
    const create = find(await init(), 'create table if not exists "shared"."record_labels"')!;
    // A null value is a bare flag, and a null deleted_at is a live row — both
    // are load-bearing states, not missing data.
    expect(create).toMatch(/"value" text[,)]/);
    expect(create).toMatch(/"deleted_at" text[,)]/);
    expect(create).toMatch(/"record_type" text not null/);
    expect(create).toMatch(/"node_id" text not null/);
  });

  it("builds the reverse index with the exact measured column order", async () => {
    const idx = find(await init(), "idx_record_labels_reverse");
    expect(idx).toBeTruthy();
    expect(idx).toContain(
      "ON shared.record_labels (app_id, key, deleted_at, value, record_id) INCLUDE (record_type)",
    );
    // ASYNC because DSQL rejects synchronous secondary indexes.
    expect(idx).toContain("CREATE INDEX ASYNC");
    // Not a partial index — DSQL rejects WHERE on CREATE INDEX, which is the
    // whole reason deleted_at is a key column.
    expect(idx).not.toMatch(/\bWHERE\b/);
  });

  it("builds the sync watermark index", async () => {
    const idx = find(await init(), "idx_record_labels_node_watermark");
    expect(idx).toContain("ON shared.record_labels (node_id, updated_at)");
  });

  it("pre-checks pg_indexes before each async index, and skips when present", async () => {
    const statements = await init();
    const probe = statements.findIndex((s) => s.includes("FROM pg_indexes"));
    const create = statements.findIndex((s) => s.includes("idx_record_labels_reverse"));
    expect(probe).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(probe);

    state.statements = [];
    state.exists = true;
    const second = await init();
    expect(second.some((s) => s.includes("CREATE INDEX ASYNC"))).toBe(false);
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
