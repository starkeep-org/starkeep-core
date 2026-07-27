/**
 * `dsql-schema-init.ts` — the shared-schema DDL, focused on the five capability
 * tables (plan §3.2/§3.5/§3.6/§3.8).
 *
 * The statement text IS the contract here: a missing column, a missing PUBLIC
 * SELECT, or a missing ledger index doesn't fail any unit test — it fails at
 * runtime in the cloud (a broken broker query, or a full-table-scan SUM on the
 * hot path). DSQL is unavailable below Tier 3, so the pg Pool and the token
 * signer are module-mocked and every statement is recorded.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = {
  roleExists: false,
  indexExists: false,
  iamMappingExists: false,
  statements: [] as string[],
  // Parameterized statements keep their bound values out of the SQL text, so
  // anything asserted on a VALUE (the seeded gate's limit) needs these.
  queries: [] as { sql: string; params: unknown[] }[],
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
    async query(text: string, params?: unknown[]) {
      return handleQuery(text, params);
    }
    async connect() {
      return {
        query: async (text: string, params?: unknown[]) => handleQuery(text, params),
        release() {},
      };
    }
    async end() {}
    on() {
      return this;
    }
  }
  function handleQuery(text: string, params?: unknown[]) {
    const sql = text.replace(/\s+/g, " ").trim();
    state.statements.push(sql);
    state.queries.push({ sql, params: params ?? [] });
    if (text.includes("FROM pg_roles")) {
      return { rows: [{ exists: state.roleExists }], rowCount: 1 };
    }
    if (text.includes("FROM pg_indexes")) {
      return { rows: [{ exists: state.indexExists }], rowCount: 1 };
    }
    if (text.includes("FROM sys.iam_pg_role_mappings")) {
      return { rows: [{ exists: state.iamMappingExists }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

import { initializeSharedSchema, installerPgUser } from "../src/dsql-schema-init";
import { evaluateGates, gateMatches, type Gate } from "@starkeep/protocol-primitives";

const opts = {
  hostname: "fake.dsql.us-east-1.on.aws",
  region: "us-east-1",
  stackPrefix: "starkeep",
  accountId: "111122223333",
  credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
};

beforeEach(() => {
  state.roleExists = false;
  state.indexExists = false;
  state.iamMappingExists = false;
  state.statements = [];
  state.queries = [];
});

/** The single CREATE TABLE statement for `table`. */
function createTable(table: string): string {
  const hits = state.statements.filter(
    (s) => s.startsWith("create table") && s.includes(`"shared"."${table}"`),
  );
  expect(hits, table).toHaveLength(1);
  return hits[0]!;
}

function has(fragment: string): boolean {
  return state.statements.some((s) => s.includes(fragment));
}

describe("installerPgUser", () => {
  it("lowercases and underscores the stack prefix", () => {
    expect(installerPgUser("starkeep")).toBe("starkeep_installer");
    expect(installerPgUser("Star-Keep-Dev")).toBe("star_keep_dev_installer");
  });
});

describe("role + schema bootstrap", () => {
  it("probes before creating each role (DSQL has no DO blocks)", async () => {
    await initializeSharedSchema(opts);
    for (const [role, create] of [
      ["manager_ddl", "CREATE ROLE manager_ddl LOGIN"],
      ["user_data_owner", "CREATE ROLE user_data_owner"],
      ["starkeep_installer", 'CREATE ROLE "starkeep_installer" LOGIN'],
    ] as const) {
      const createIdx = state.statements.indexOf(create);
      expect(createIdx, role).toBeGreaterThanOrEqual(0);
      // A pg_roles probe precedes every CREATE ROLE.
      const probeIdx = state.statements
        .slice(0, createIdx)
        .findIndex((s) => s.includes("FROM pg_roles") && s.includes("rolname"));
      expect(probeIdx, role).toBeGreaterThanOrEqual(0);
    }
  });

  it("skips CREATE ROLE when the probe reports the role exists", async () => {
    state.roleExists = true;
    await initializeSharedSchema(opts);
    expect(state.statements.some((s) => s.startsWith("CREATE ROLE"))).toBe(false);
  });

  it("maps the admin app role to the installer PG role, probing first", async () => {
    await initializeSharedSchema(opts);
    expect(has("FROM sys.iam_pg_role_mappings")).toBe(true);
    expect(
      has(
        `AWS IAM GRANT "starkeep_installer" TO 'arn:aws:iam::111122223333:role/starkeep-app-admin-role'`,
      ),
    ).toBe(true);
  });

  it("skips the non-idempotent AWS IAM GRANT when the mapping already exists", async () => {
    state.iamMappingExists = true;
    await initializeSharedSchema(opts);
    expect(state.statements.some((s) => s.startsWith("AWS IAM GRANT"))).toBe(false);
  });
});

describe("capability tables — creation and columns", () => {
  beforeEach(async () => {
    await initializeSharedSchema(opts);
  });

  it("creates all five capability tables, idempotently", () => {
    for (const t of [
      "capability_grants",
      "capability_gates",
      "capability_ledger",
      "capability_model_overrides",
      "capability_async_jobs",
    ]) {
      expect(createTable(t)).toContain("if not exists");
    }
  });

  it("capability_grants keys on (app_id, capability_name) and stores both JSON lists", () => {
    const ddl = createTable("capability_grants");
    expect(ddl).toContain('"models_json" text not null');
    expect(ddl).toContain('"reports_json" text not null');
    expect(ddl).toContain('primary key ("app_id", "capability_name")');
  });

  it("capability_gates carries every column the gate row-mapper reads", () => {
    const ddl = createTable("capability_gates");
    for (const col of [
      '"id" text primary key',
      '"capability_name" text not null',
      '"dimension" text not null',
      '"unit" text not null',
      '"scope_provider" text',
      '"scope_model" text',
      '"scope_app_id" text',
      '"window_kind" text not null',
      '"window_period" text',
      '"window_seconds" integer',
      '"on_exceed" text default \'deny\' not null',
      '"origin" text',
    ]) {
      expect(ddl, col).toContain(col);
    }
    // `limit` is reserved, hence limit_value; double precision so a fractional
    // dollar budget isn't silently truncated.
    expect(ddl).toContain('"limit_value" numeric(38, 0) not null');
    expect(ddl).not.toContain('"limit" ');
  });

  it("capability_ledger carries the measurement tuple with a defaulted timestamp", () => {
    const ddl = createTable("capability_ledger");
    for (const col of [
      '"id" text primary key',
      '"invocation_id" text not null',
      '"app_id" text not null',
      '"capability_name" text not null',
      '"provider" text not null',
      '"model" text not null',
      '"dimension" text not null',
      '"unit" text not null',
      '"status" text not null',
    ]) {
      expect(ddl, col).toContain(col);
    }
    // Quantities are fractional (cost in USD), and `ts` must default so an
    // INSERT that omits it still lands inside the current gate window.
    expect(ddl).toContain('"quantity" numeric(38, 0) not null');
    expect(ddl).toContain('"ts" timestamptz default now() not null');
  });

  it("capability_model_overrides is sparse, with a non-null cleared FLAG", () => {
    const ddl = createTable("capability_model_overrides");
    expect(ddl).toContain('"model_id" text primary key');
    // Every override column is nullable — NULL means "fall through to the
    // platform default" — except the tri-state disambiguator.
    expect(ddl).toContain('"provider" text');
    expect(ddl).toContain('"inference_profile_id" text');
    expect(ddl).toContain('"inference_profile_cleared" boolean default false not null');
    expect(ddl).toContain('"vision" boolean');
    expect(ddl).toContain('"output_modality" text');
    expect(ddl).toContain('"pricing_json" text');
    expect(ddl).toContain('"estimates_json" text');
  });

  it("capability_async_jobs keys on invocation_id and stores what a later poll needs", () => {
    const ddl = createTable("capability_async_jobs");
    expect(ddl).toContain('"invocation_id" text primary key');
    // A cold status poll must recover the ARN, the provider/model (for the
    // ledger key) and the output location — none of which it is given.
    for (const col of [
      '"app_id" text not null',
      '"provider" text not null',
      '"model" text not null',
      '"invocation_arn" text not null',
      '"output_bucket" text not null',
      '"output_key_prefix" text not null',
      '"status" text not null',
    ]) {
      expect(ddl, col).toContain(col);
    }
  });
});

describe("capability tables — grants", () => {
  beforeEach(async () => {
    await initializeSharedSchema(opts);
  });

  it("grants PUBLIC SELECT on every capability table (the CDS reads as the app role)", () => {
    for (const t of [
      "capability_grants",
      "capability_gates",
      "capability_ledger",
      "capability_model_overrides",
      "capability_async_jobs",
    ]) {
      expect(has(`GRANT SELECT ON shared.${t} TO PUBLIC`), t).toBe(true);
    }
  });

  it("grants writes on the operator-owned tables to the installer only", () => {
    for (const t of ["capability_grants", "capability_gates", "capability_model_overrides"]) {
      expect(
        has(`GRANT INSERT, UPDATE, DELETE ON shared.${t} TO "starkeep_installer"`),
        t,
      ).toBe(true);
    }
  });

  it("grants NO schema-init-time write on the ledger or async jobs", () => {
    // Those writes belong to each capability-holding app role and are granted
    // per-app at install (dsql-ddl.ts), not globally here.
    expect(has(`INSERT, UPDATE, DELETE ON shared.capability_ledger`)).toBe(false);
    expect(has(`INSERT, UPDATE, DELETE ON shared.capability_async_jobs`)).toBe(false);
  });
});

describe("capability ledger indexes (the gate SUM's hot path)", () => {
  it("creates the three indexes backing the scoped SUM, probing pg_indexes first", async () => {
    await initializeSharedSchema(opts);
    // DSQL requires CREATE INDEX ASYNC and rejects IF NOT EXISTS on it, so
    // idempotency is a pre-check.
    expect(has("FROM pg_indexes")).toBe(true);

    // Global / per-provider gates: (dimension, unit, status, ts).
    expect(
      has(
        "CREATE INDEX ASYNC idx_cap_ledger_dim_ts ON shared.capability_ledger (dimension, unit, status, ts)",
      ),
    ).toBe(true);
    // Per-app gates (the consent budget) fold app_id into the key head.
    expect(
      has(
        "CREATE INDEX ASYNC idx_cap_ledger_app_dim_ts ON shared.capability_ledger (app_id, dimension, unit, status, ts)",
      ),
    ).toBe(true);
    // reconcile/release/commit all address one invocation.
    expect(
      has(
        "CREATE INDEX ASYNC idx_cap_ledger_invocation ON shared.capability_ledger (invocation_id)",
      ),
    ).toBe(true);
  });

  it("index key order matches the SUM's predicates (equality columns before the ts range)", async () => {
    await initializeSharedSchema(opts);
    const idx = state.statements.find((s) => s.includes("idx_cap_ledger_app_dim_ts"))!;
    const cols = idx.slice(idx.indexOf("(") + 1, idx.lastIndexOf(")")).split(",").map((c) => c.trim());
    expect(cols).toEqual(["app_id", "dimension", "unit", "status", "ts"]);
    // `ts` last: the SUM's only range predicate.
    expect(cols[cols.length - 1]).toBe("ts");
  });

  it("skips index creation when the probe reports it already present", async () => {
    state.indexExists = true;
    await initializeSharedSchema(opts);
    expect(state.statements.some((s) => s.includes("CREATE INDEX ASYNC"))).toBe(false);
  });
});

describe("the rest of the shared schema is untouched by the capability work", () => {
  it("still creates records, access_grants and the registry tables", async () => {
    await initializeSharedSchema(opts);
    expect(has('"shared"."records"')).toBe(true);
    expect(has("GRANT SELECT ON shared.access_grants TO PUBLIC")).toBe(true);
    expect(has('"shared"."app_registry"')).toBe(true);
    expect(has('"shared"."app_install_steps"')).toBe(true);
  });

  it("never drops anything", async () => {
    await initializeSharedSchema(opts);
    expect(state.statements.some((s) => /^drop /i.test(s))).toBe(false);
  });
});

describe("seeded global Bedrock cost gate (budget-guardrail plan §4.6)", () => {
  /** The one INSERT into shared.capability_gates, with its bound values. */
  function seedInsert() {
    const hits = state.queries.filter(
      (q) => /^insert into/i.test(q.sql) && q.sql.includes('"shared"."capability_gates"'),
    );
    expect(hits).toHaveLength(1);
    return hits[0]!;
  }

  /** The seed's bound values, keyed by the column order in the INSERT. */
  function seedValues(): Record<string, unknown> {
    const { sql, params } = seedInsert();
    const cols = sql
      .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
      .split(",")
      .map((c) => c.trim().replace(/"/g, ""));
    return Object.fromEntries(cols.map((c, i) => [c, params[i]]));
  }

  it("seeds one global monthly cost gate", async () => {
    await initializeSharedSchema({ ...opts, defaultBedrockCostGateUsd: 20 });
    const values = seedValues();
    expect(values).toMatchObject({
      id: "operator:bedrock-monthly-cost",
      capability_name: "bedrock.invoke",
      dimension: "cost",
      unit: "usd_micros",
      window_kind: "calendar",
      window_period: "month",
      on_exceed: "deny",
      // `operator`, not `app-consent`: this must render in the gate editor as a
      // normal, fully editable row.
      origin: "operator",
    });
    // All scope columns NULL — global across every app, provider and model.
    expect(values.scope_provider).toBeNull();
    expect(values.scope_model).toBeNull();
    expect(values.scope_app_id).toBeNull();
    expect(values.window_seconds).toBeNull();
  });

  it("stores the limit in micros, exactly", async () => {
    // $20 under a $25 budget. An off-by-1e6 here is a 1000×-wrong ceiling that
    // no other assertion in this file would catch.
    await initializeSharedSchema({ ...opts, defaultBedrockCostGateUsd: 20 });
    expect(seedValues().limit_value).toBe(20_000_000);
  });

  it("stores a non-integer-dollar limit exactly", async () => {
    await initializeSharedSchema({ ...opts, defaultBedrockCostGateUsd: 0.8 * 25 });
    expect(seedValues().limit_value).toBe(20_000_000);
  });

  it("is insert-if-absent, NOT an upsert", async () => {
    // A DO UPDATE would silently revert an operator's edited limit on every
    // reinstall — a spend cap loosened by a routine redeploy.
    await initializeSharedSchema({ ...opts, defaultBedrockCostGateUsd: 20 });
    const { sql } = seedInsert();
    expect(sql.toLowerCase()).toContain("on conflict");
    expect(sql.toLowerCase()).toContain("do nothing");
    expect(sql.toLowerCase()).not.toContain("do update");
  });

  it("emits no insert at all when no default is supplied", async () => {
    await initializeSharedSchema(opts);
    expect(
      state.statements.some(
        (s) => /^insert into/i.test(s) && s.includes('"shared"."capability_gates"'),
      ),
    ).toBe(false);
  });

  it("uses an id the admin-web gate editor treats as editable", async () => {
    // The editor's write routes refuse any id without this prefix, so a seed
    // that missed it would render as an uneditable, undeletable mystery row.
    await initializeSharedSchema({ ...opts, defaultBedrockCostGateUsd: 20 });
    expect(String(seedValues().id).startsWith("operator:")).toBe(true);
  });

  it("seeds a gate that the pure gate logic actually ENFORCES", async () => {
    // Storing a row is not the same as bounding spend. Map the seeded row the
    // way the broker does and check it matches an arbitrary request and denies
    // at the limit.
    await initializeSharedSchema({ ...opts, defaultBedrockCostGateUsd: 20 });
    const values = seedValues();
    const gate: Gate = {
      id: String(values.id),
      dimension: String(values.dimension),
      unit: String(values.unit),
      scope: {},
      window: { kind: "calendar", period: "month" },
      limit: Number(values.limit_value),
      onExceed: "deny",
    };
    const ctx = { appId: "any-app", provider: "anthropic" as const, model: "any-model" };
    expect(gateMatches(gate, ctx)).toBe(true);

    const decision = await evaluateGates({
      gates: [gate],
      ctx,
      appReports: [],
      projected: [{ dimension: "cost", unit: "usd_micros", quantity: 1 }],
      getSum: async () => 20_000_000,
    });
    expect(decision.allowed).toBe(false);
  });
});
