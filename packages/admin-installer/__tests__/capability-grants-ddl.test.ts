/**
 * The install-time capability grant + consent-gate DDL (plan §3.2).
 *
 * `dsql-ddl.test.ts` pins the statement SEQUENCE; this file pins the VALUES,
 * because the budget→gate translation is the primary cost limit in the system
 * and a statement that merely *mentions* `capability_gates` proves nothing about
 * the limit it wrote. The pg mock here records bound parameters as well as SQL.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

interface Recorded {
  text: string;
  values: unknown[];
}

const state = {
  pgRoleExists: false,
  iamMappingExists: false,
  overrides: [] as Record<string, unknown>[],
  queries: [] as Recorded[],
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
    async query(text: string, values?: unknown[]) {
      return handleQuery(text, values);
    }
    async connect() {
      return {
        query: async (text: string, values?: unknown[]) => handleQuery(text, values),
        release() {},
      };
    }
    async end() {}
    on() {
      return this;
    }
  }
  function handleQuery(text: string, values?: unknown[]) {
    state.queries.push({ text: text.replace(/\s+/g, " ").trim(), values: values ?? [] });
    if (text.includes("FROM pg_roles")) {
      return { rows: [{ exists: state.pgRoleExists }], rowCount: 1 };
    }
    if (text.includes("FROM sys.iam_pg_role_mappings")) {
      return { rows: [{ exists: state.iamMappingExists }], rowCount: 1 };
    }
    if (text.includes("capability_model_overrides")) {
      return { rows: state.overrides, rowCount: state.overrides.length };
    }
    return { rows: [], rowCount: 0 };
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

import { runAppInstallDdl, runAppUninstallDdl, type DsqlDdlOptions } from "../src/dsql-ddl";

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
  state.overrides = [];
  state.queries = [];
});

/** The one recorded statement matching `match` (fails if not exactly one). */
function one(match: RegExp | string): Recorded {
  const hits = state.queries.filter((q) =>
    typeof match === "string" ? q.text.includes(match) : match.test(q.text),
  );
  expect(hits).toHaveLength(1);
  return hits[0]!;
}

function all(match: string): Recorded[] {
  return state.queries.filter((q) => q.text.includes(match));
}

const PHOTOS_CAP = {
  name: "bedrock.invoke",
  models: ["anthropic.claude-haiku-4-5", "amazon.nova-lite"],
  required: true,
  requestedMonthlyBudgetUsd: 20,
  reports: ["input:megapixels"],
  rationale: "captions",
};

function install(caps: unknown[], appId = "photos") {
  return runAppInstallDdl(
    opts,
    appId,
    [],
    false,
    [],
    false,
    caps as Parameters<typeof runAppInstallDdl>[6],
  );
}

// ---------------------------------------------------------------------------
// capability_grants row
// ---------------------------------------------------------------------------

describe("capability_grants row values", () => {
  it("stores the app, capability, approved models and declared reports", async () => {
    await install([PHOTOS_CAP]);
    const q = one("capability_grants");
    expect(q.values).toEqual([
      "photos",
      "bedrock.invoke",
      JSON.stringify(["anthropic.claude-haiku-4-5", "amazon.nova-lite"]),
      JSON.stringify(["input:megapixels"]),
    ]);
  });

  it("stores an empty reports list when the manifest declares none", async () => {
    await install([{ ...PHOTOS_CAP, reports: [] }]);
    expect(one("capability_grants").values[3]).toBe("[]");
  });

  it("treats an omitted reports field as an empty list", async () => {
    const { reports: _drop, ...noReports } = PHOTOS_CAP;
    await install([noReports]);
    expect(one("capability_grants").values[3]).toBe("[]");
  });

  it("upserts on (app_id, capability_name) so a reinstall updates in place", async () => {
    await install([PHOTOS_CAP]);
    const q = one("capability_grants");
    expect(q.text).toContain('on conflict ("app_id", "capability_name") do update');
    expect(q.text).toContain('"models_json" = "excluded"."models_json"');
    expect(q.text).toContain('"reports_json" = "excluded"."reports_json"');
  });

  it("writes one grant row per declared capability", async () => {
    await install([PHOTOS_CAP, { ...PHOTOS_CAP, name: "bedrock.invoke", models: ["kimi.k2"] }]);
    expect(all("capability_grants")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The consent budget → cost gate (the primary spend limit)
// ---------------------------------------------------------------------------

describe("consent budget → capability_gates row", () => {
  it("translates the consented monthly budget into a per-app monthly cost gate", async () => {
    await install([PHOTOS_CAP]);
    const q = one("capability_gates");
    // id, capability_name, dimension, unit, scope_provider, scope_model,
    // scope_app_id, window_kind, window_period, window_seconds, limit_value,
    // on_exceed, origin
    expect(q.values).toEqual([
      "consent:photos:bedrock.invoke",
      "bedrock.invoke",
      "cost",
      "usd",
      null,
      null,
      "photos",
      "calendar",
      "month",
      null,
      20,
      "deny",
      "app-consent",
    ]);
  });

  it("scopes the gate to the app alone — not to a provider or model", async () => {
    await install([PHOTOS_CAP]);
    const v = one("capability_gates").values;
    expect(v[4]).toBeNull(); // scope_provider — wildcard
    expect(v[5]).toBeNull(); // scope_model — wildcard
    expect(v[6]).toBe("photos");
  });

  it("marks the gate's origin as app-consent (distinguishable from operator gates)", async () => {
    await install([PHOTOS_CAP]);
    expect(one("capability_gates").values[12]).toBe("app-consent");
  });

  it("uses a deterministic id and upserts the LIMIT on reinstall (no duplicate gates)", async () => {
    await install([PHOTOS_CAP]);
    const q = one("capability_gates");
    expect(q.values[0]).toBe("consent:photos:bedrock.invoke");
    expect(q.text).toContain('on conflict ("id") do update');
    expect(q.text).toContain('"limit_value" = "excluded"."limit_value"');
  });

  it("carries a changed budget through on reinstall", async () => {
    await install([{ ...PHOTOS_CAP, requestedMonthlyBudgetUsd: 5 }]);
    expect(one("capability_gates").values[10]).toBe(5);
  });

  it("writes NO gate when the app requested no budget (unbounded until the operator sets one)", async () => {
    const { requestedMonthlyBudgetUsd: _drop, ...noBudget } = PHOTOS_CAP;
    await install([noBudget]);
    expect(all("capability_gates")).toHaveLength(0);
    // The grant itself is still written — no budget ≠ no capability.
    expect(all("capability_grants")).toHaveLength(1);
  });

  it("writes a ZERO-budget gate rather than skipping it (0 must deny, not mean 'unset')", async () => {
    await install([{ ...PHOTOS_CAP, requestedMonthlyBudgetUsd: 0 }]);
    const q = one("capability_gates");
    expect(q.values[10]).toBe(0);
  });

  it("keys the gate id by app AND capability, so two apps get independent gates", async () => {
    await install([PHOTOS_CAP], "notes");
    expect(one("capability_gates").values[0]).toBe("consent:notes:bedrock.invoke");
  });
});

// ---------------------------------------------------------------------------
// Model validation against the EFFECTIVE registry
// ---------------------------------------------------------------------------

describe("model validation at install", () => {
  it("accepts an operator-DEFINED model that the platform registry doesn't know", async () => {
    state.overrides = [
      {
        model_id: "acme.custom-1",
        provider: "amazon",
        inference_profile_id: null,
        inference_profile_cleared: null,
        vision: null,
        output_modality: null,
        pricing_json: null,
        estimates_json: null,
      },
    ];
    await install([{ ...PHOTOS_CAP, models: ["acme.custom-1"] }]);
    expect(one("capability_grants").values[2]).toBe(JSON.stringify(["acme.custom-1"]));
  });

  it("rejects an unknown model before writing any grant row", async () => {
    await expect(install([{ ...PHOTOS_CAP, models: ["nope.nope"] }])).rejects.toThrow(
      /neither platform-known nor operator-defined/,
    );
    expect(all("capability_grants")).toHaveLength(0);
    expect(all("capability_gates")).toHaveLength(0);
  });

  it("rejects the whole capability when ONE of several models is unknown", async () => {
    await expect(
      install([{ ...PHOTOS_CAP, models: ["anthropic.claude-haiku-4-5", "nope.nope"] }]),
    ).rejects.toThrow(/nope\.nope/);
    expect(all("capability_grants")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ledger write grants
// ---------------------------------------------------------------------------

describe("ledger write grants", () => {
  it("grants the app's PG role INSERT/UPDATE on the ledger and async-jobs tables", async () => {
    await install([PHOTOS_CAP]);
    expect(
      state.queries.some((q) =>
        q.text.includes("GRANT INSERT, UPDATE ON shared.capability_ledger TO starkeep_app_photos"),
      ),
    ).toBe(true);
    expect(
      state.queries.some((q) =>
        q.text.includes("GRANT INSERT, UPDATE ON shared.capability_async_jobs TO starkeep_app_photos"),
      ),
    ).toBe(true);
  });

  it("never grants DELETE on the append-only ledger", async () => {
    await install([PHOTOS_CAP]);
    const grants = state.queries.filter((q) => q.text.includes("ON shared.capability_ledger"));
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((q) => !q.text.includes("DELETE"))).toBe(true);
  });

  it("writes no capability SQL at all for an app that declares none", async () => {
    await install([]);
    expect(state.queries.some((q) => q.text.includes("capability_"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

describe("uninstall capability cleanup", () => {
  beforeEach(async () => {
    state.pgRoleExists = true;
    state.iamMappingExists = true;
    await runAppUninstallDdl(opts, "photos", [], false);
  });

  it("deletes the app's grants, ledger rows and async jobs by app_id", async () => {
    for (const table of ["capability_grants", "capability_ledger", "capability_async_jobs"]) {
      const q = one(`delete from "shared"."${table}"`);
      expect(q.text).toContain('"app_id" = $1');
      expect(q.values).toEqual(["photos"]);
    }
  });

  it("deletes gates by SCOPE_APP_ID, so operator global/provider gates survive", async () => {
    const q = one('delete from "shared"."capability_gates"');
    // Filtering on scope_app_id (not app_id) is what leaves a global operator
    // gate — whose scope_app_id is NULL — in place across an app uninstall.
    expect(q.text).toContain('"scope_app_id" = $1');
    expect(q.text).not.toContain('"app_id" = $1');
    expect(q.values).toEqual(["photos"]);
  });

  it("revokes the ledger write grants before dropping the role", async () => {
    const revokeIdx = state.queries.findIndex((q) =>
      q.text.includes("REVOKE ALL ON shared.capability_ledger"),
    );
    const dropIdx = state.queries.findIndex((q) => q.text.startsWith("DROP ROLE"));
    expect(revokeIdx).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeGreaterThan(revokeIdx);
  });

  it("never drops the shared capability tables themselves", async () => {
    expect(state.queries.some((q) => /DROP TABLE.*capability/i.test(q.text))).toBe(false);
  });
});
